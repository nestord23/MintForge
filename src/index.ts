/**
 * MintForge — Solana NFT Collection Generator & Minter
 *
 * Core pipeline that:
 * 1. Loads a Solana wallet and connects to the configured RPC.
 * 2. Scans the `assets/` directory for image / video files.
 * 3. Uploads assets and their metadata JSON to Irys (Arweave).
 * 4. Creates a collection NFT and mints individual NFTs via Metaplex.
 * 5. Caches every intermediate URI and mint address to allow resuming
 *    interrupted runs and to avoid redundant uploads / mints.
 *
 * Two modes:
 *   - **New collection** (no COLLECTION_ADDRESS in .env):
 *     Uploads every image, creates a collection NFT, mints NFTs.
 *   - **Add to existing collection** (COLLECTION_ADDRESS set):
 *     Reuses cached image URIs, uploads fresh metadata, mints additional
 *     sequentially-numbered NFTs.
 *
 * Usage:  pnpm start
 *         tsx src/index.ts
 */

import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, clusterApiUrl } from '@solana/web3.js';
import { Metaplex, keypairIdentity } from '@metaplex-foundation/js';
import Irys from '@irys/sdk';
import { fileURLToPath } from 'url';

dotenv.config();

// ─── Paths ───────────────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const RPC = process.env.SOLANA_RPC || clusterApiUrl('devnet');
const NETWORK = process.env.SOLANA_NETWORK || 'devnet';
const KEYPAIR_PATH = path.resolve(ROOT, process.env.KEYPAIR_PATH || './keypair.json');
const COLLECTION_NAME = process.env.COLLECTION_NAME || 'MintForge Collection';
const COLLECTION_SYMBOL = process.env.COLLECTION_SYMBOL || 'MFORGE';
const COLLECTION_DESCRIPTION = process.env.COLLECTION_DESCRIPTION || 'Generated with MintForge';
const COLLECTION_ADDRESS = process.env.COLLECTION_ADDRESS || '';
const IRYS_NODE = NETWORK === 'devnet' ? 'https://devnet.irys.xyz' : 'https://node1.irys.xyz';
const IRYS_GATEWAY = 'https://gateway.irys.xyz';
const ASSETS_DIR = path.join(ROOT, 'assets');
const CACHE_PATH = path.join(ROOT, 'cache', 'upload-cache.json');

/** Whether we are adding to an existing collection or starting from scratch. */
const IS_EXISTING_COLLECTION = COLLECTION_ADDRESS.length > 0;

// ─── Types ───────────────────────────────────────────────────────────────────

/** A single file found inside the `assets/` directory. */
interface Asset {
  /** Filename including extension (e.g. `"foto1.jpg"`). */
  file: string;
  /** Lowercase extension including the dot (e.g. `".jpg"`). */
  ext: string;
}

/** A cached entry for one NFT (either from an image file or an auto-generated one). */
interface NftCacheEntry {
  /** Source filename, or `null` for auto-generated entries in "add to collection" mode. */
  file: string | null;
  /** Optional human-readable label (set for auto-generated entries). */
  label?: string;
  /** Irys gateway URL of the uploaded image. */
  image: string;
  /** Irys gateway URL of the uploaded metadata JSON. */
  metadata?: string;
  /** On-chain mint address of the NFT. */
  mintAddress?: string;
}

/** Cached data for the collection NFT itself. */
interface CollectionCache {
  /** Irys gateway URL of the collection image. */
  image?: string;
  /** Irys gateway URL of the collection metadata JSON. */
  metadata?: string;
  /** On-chain mint address of the collection NFT. */
  mintAddress?: string;
}

/** Shape of the on-disk cache file (`cache/upload-cache.json`). */
interface UploadCache {
  /** Collection-level cache (null before the first run). */
  collection: CollectionCache | null;
  /** Ordered list of cached individual NFTs. */
  nfts: NftCacheEntry[];
  /** Total number of NFTs minted so far (used for sequencing). */
  totalMinted: number;
}

/** Result produced after minting one NFT. */
interface NftResult {
  name: string;
  address: string;
  uri: string;
}

/** A single on-chain attribute (trait). */
interface MetadataAttribute {
  trait_type: string;
  value: string;
}

/** A creator entry in the Metaplex metadata. */
interface MetadataCreator {
  address: string;
  share: number;
}

/** A file entry inside the Metaplex `properties.files` array. */
interface MetadataFile {
  uri: string;
  type: string;
}

/** The `properties` section of Metaplex metadata. */
interface MetadataProperties {
  files: MetadataFile[];
  category: string;
  creators: MetadataCreator[];
}

/**
 * Full Metaplex-compatible NFT metadata object.
 *
 * Reference: https://docs.metaplex.com/programs/token-metadata/token-standard
 */
interface Metadata {
  name: string;
  symbol: string;
  description: string;
  image: string;
  /** Royalty basis points (e.g. 500 = 5 %).  Absent for the collection NFT. */
  seller_fee_basis_points?: number;
  /** Trait list.  Absent for the collection NFT. */
  attributes?: MetadataAttribute[];
  properties: MetadataProperties;
}

// ─── Constants ──────────────────────────────────────────────────────────────

/** Valid image / video file extensions that are recognised as NFT assets. */
const VALID_ASSET_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.mp4']);

/** Irys funding safety multiplier — we fund 1.5× the estimated price. */
const IRYS_FUND_MULTIPLIER = 1.5;

/** Minimum SOL balance before an automatic airdrop is requested inside `main()`. */
const MIN_BALANCE_SOL = 0.01;

/** Default seller fee in basis points for individual NFTs (500 = 5 %). */
const SELLER_FEE_BPS = 500;

// ─── Utility Functions ──────────────────────────────────────────────────────

/**
 * Prints an indented log message to the console.
 *
 * @param msg - The message to display.
 */
function log(msg: string): void {
  console.log(`  ${msg}`);
}

/**
 * Prompts the user with a question and waits for a text response on stdin.
 *
 * @param query - The prompt text shown to the user.
 * @returns A promise that resolves to the trimmed user input.
 */
function ask(query: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(query, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * Loads the Solana wallet from the JSON keypair file on disk.
 *
 * Exits the process with an error message if the file does not exist
 * (the user should run `pnpm setup` first).
 *
 * @returns A Solana {@link Keypair} instance.
 */
function loadWallet(): Keypair {
  if (!fs.existsSync(KEYPAIR_PATH)) {
    console.error('\n❌ No wallet found. Run `pnpm setup` first.\n');
    process.exit(1);
  }

  const raw = fs.readFileSync(KEYPAIR_PATH, 'utf-8');

  if (typeof raw !== 'string') {
    throw new Error(`Failed to read keypair file at ${KEYPAIR_PATH}`);
  }

  const data = JSON.parse(raw);

  if (!Array.isArray(data) || data.length === 0) {
    throw new Error(`Invalid keypair: expected a non-empty array at ${KEYPAIR_PATH}`);
  }

  return Keypair.fromSecretKey(new Uint8Array(data));
}

/**
 * Scans the `assets/` directory and returns a sorted list of recognised
 * image / video files.
 *
 * If the directory does not exist it is created (empty list returned).
 *
 * @returns An array of {@link Asset} objects sorted alphabetically by filename.
 */
function getAssets(): Asset[] {
  if (!fs.existsSync(ASSETS_DIR)) {
    fs.mkdirSync(ASSETS_DIR, { recursive: true });
    return [];
  }

  const files = fs.readdirSync(ASSETS_DIR);

  if (!Array.isArray(files)) {
    throw new Error('Failed to read assets directory');
  }

  return files
    .filter((f) => typeof f === 'string')
    .filter((f) => VALID_ASSET_EXTENSIONS.has(path.extname(f).toLowerCase()))
    .map((f) => ({ file: f, ext: path.extname(f).toLowerCase() }))
    .sort((a, b) => a.file.localeCompare(b.file));
}

/**
 * Maps a file extension to its MIME type.
 *
 * @param ext - Lowercase file extension including the dot (e.g. `".jpg"`).
 * @returns The corresponding MIME type string, falling back to `application/octet-stream`.
 */
function getMimeType(ext: string): string {
  if (typeof ext !== 'string') {
    return 'application/octet-stream';
  }

  const map: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.mp4': 'video/mp4',
  };

  return map[ext] || 'application/octet-stream';
}

/**
 * Loads the upload cache from disk.
 *
 * If the cache file does not exist yet, a fresh empty cache structure is
 * returned.  The returned object is validated to have the expected shape.
 *
 * @returns A validated {@link UploadCache} object.
 */
function loadCache(): UploadCache {
  if (fs.existsSync(CACHE_PATH)) {
    const raw = fs.readFileSync(CACHE_PATH, 'utf-8');

    if (typeof raw !== 'string') {
      throw new Error('Failed to read cache file');
    }

    const parsed = JSON.parse(raw);

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('Invalid cache: expected a JSON object');
    }

    return {
      collection: (typeof parsed.collection === 'object' && parsed.collection !== null) ? parsed.collection : null,
      nfts: Array.isArray(parsed.nfts) ? parsed.nfts : [],
      totalMinted: typeof parsed.totalMinted === 'number' ? parsed.totalMinted : 0,
    };
  }

  return { collection: null, nfts: [], totalMinted: 0 };
}

/**
 * Persists the upload cache to disk, creating intermediate directories as needed.
 *
 * @param cache - The {@link UploadCache} object to save.
 */
function saveCache(cache: UploadCache): void {
  if (typeof cache !== 'object' || cache === null) {
    throw new Error('Invalid cache: expected an object');
  }

  const dir = path.dirname(CACHE_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
}

/**
 * Generates the trait list for a single NFT based on its index and the total
 * collection size.  Rarity cycles through five levels.
 *
 * @param index - Zero-based index of the NFT within the collection.
 * @param total - Total number of NFTs in the collection.
 * @returns An array of metadata attributes (Edition, Rarity, Collection Size).
 */
function generateAttributes(index: number, total: number): MetadataAttribute[] {
  if (typeof index !== 'number' || isNaN(index) || index < 0) {
    throw new Error(`Invalid NFT index: ${index}`);
  }
  if (typeof total !== 'number' || isNaN(total) || total < 1) {
    throw new Error(`Invalid total count: ${total}`);
  }

  const rarities = ['Common', 'Uncommon', 'Rare', 'Epic', 'Legendary'];
  const rarity = rarities[index % rarities.length];

  return [
    { trait_type: 'Edition', value: `#${index + 1}` },
    { trait_type: 'Rarity', value: rarity },
    { trait_type: 'Collection Size', value: `${total}` },
  ];
}

/**
 * Builds a Metaplex-compatible metadata JSON object for either a collection NFT
 * or an individual NFT.
 *
 * **Collection NFT** metadata omits `seller_fee_basis_points` and `attributes`.
 * **Individual NFT** metadata includes a 5 % seller fee and three traits.
 *
 * @param index         - Zero-based index of the NFT (ignored for collection).
 * @param total         - Total NFTs in the collection (ignored for collection).
 * @param imageUri      - Irys gateway URL of the uploaded image.
 * @param walletAddress - Base-58 public key of the creator wallet.
 * @param isCollection  - Whether this metadata is for the collection NFT itself.
 * @returns A full {@link Metadata} object ready for JSON serialisation.
 */
function generateMetadata(
  index: number,
  total: number,
  imageUri: string,
  walletAddress: string,
  isCollection: boolean = false,
): Metadata {
  if (typeof imageUri !== 'string' || imageUri.length === 0) {
    throw new Error('imageUri must be a non-empty string');
  }
  if (typeof walletAddress !== 'string' || walletAddress.length === 0) {
    throw new Error('walletAddress must be a non-empty string');
  }

  const imageType = getMimeType(path.extname(imageUri) || '.png');
  const files: MetadataFile[] = [{ uri: imageUri, type: imageType }];
  const creators: MetadataCreator[] = [{ address: walletAddress, share: 100 }];

  if (isCollection) {
    return {
      name: COLLECTION_NAME,
      symbol: COLLECTION_SYMBOL,
      description: COLLECTION_DESCRIPTION,
      image: imageUri,
      properties: { files, category: 'image', creators },
    };
  }

  return {
    name: `${COLLECTION_NAME} #${index + 1}`,
    symbol: COLLECTION_SYMBOL,
    description: COLLECTION_DESCRIPTION,
    seller_fee_basis_points: SELLER_FEE_BPS,
    image: imageUri,
    attributes: generateAttributes(index, total),
    properties: { files, category: 'image', creators },
  };
}

// ─── Irys Upload Functions ─────────────────────────────────────────────────

/**
 * Uploads a file (image / video) to the Irys decentralised storage network.
 *
 * If the current Irys balance is insufficient to cover the upload price, the
 * wallet is funded with 1.5× the difference automatically.
 *
 * @param irys     - Initialised Irys SDK instance.
 * @param filePath - Absolute path to the file on disk.
 * @param tags     - Key-value tags attached to the upload (e.g. Content-Type).
 * @returns The Irys gateway URL for the uploaded content.
 */
async function uploadToIrys(irys: Irys, filePath: string, tags: { name: string; value: string }[]): Promise<string> {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    throw new Error('filePath must be a non-empty string');
  }
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }
  if (!Array.isArray(tags)) {
    throw new Error('tags must be an array');
  }

  const fileSize = fs.statSync(filePath).size;

  if (typeof fileSize !== 'number' || fileSize < 0) {
    throw new Error(`Invalid file size for ${filePath}`);
  }

  const price = await irys.getPrice(fileSize);
  const balance = await irys.getLoadedBalance();

  if (price.isGreaterThan(balance)) {
    const amount = price.minus(balance).multipliedBy(IRYS_FUND_MULTIPLIER).integerValue();

    if (typeof amount !== 'object' || amount === null) {
      throw new Error('Failed to compute Irys fund amount');
    }

    log(`Funding Irys with ${amount.dividedBy(LAMPORTS_PER_SOL).toFixed(6)} SOL...`);
    try {
      await irys.fund(amount);
    } catch (e: unknown) {
      log(`Fund warning: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const receipt = await irys.uploadFile(filePath, { tags });

  if (typeof receipt !== 'object' || receipt === null || typeof receipt.id !== 'string') {
    throw new Error('Irys upload did not return a valid receipt');
  }

  return `${IRYS_GATEWAY}/${receipt.id}`;
}

/**
 * Uploads a metadata JSON object to the Irys network with the
 * `Content-Type: application/json` tag.
 *
 * Follows the same balance-check-and-fund pattern as {@link uploadToIrys}.
 *
 * @param irys - Initialised Irys SDK instance.
 * @param data - The metadata object to serialise and upload.
 * @returns The Irys gateway URL for the uploaded JSON.
 */
async function uploadJsonToIrys(irys: Irys, data: Record<string, unknown>): Promise<string> {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new Error('data must be a non-null object');
  }

  const json = JSON.stringify(data);

  if (typeof json !== 'string') {
    throw new Error('Failed to serialise metadata to JSON');
  }

  const fileSize = Buffer.byteLength(json);
  const price = await irys.getPrice(fileSize);
  const balance = await irys.getLoadedBalance();

  if (price.isGreaterThan(balance)) {
    const amount = price.minus(balance).multipliedBy(IRYS_FUND_MULTIPLIER).integerValue();
    log('Funding Irys metadata upload...');
    try {
      await irys.fund(amount);
    } catch (e: unknown) {
      log(`Fund warning: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const receipt = await irys.upload(json, {
    tags: [{ name: 'Content-Type', value: 'application/json' }],
  });

  if (typeof receipt !== 'object' || receipt === null || typeof receipt.id !== 'string') {
    throw new Error('Irys JSON upload did not return a valid receipt');
  }

  return `${IRYS_GATEWAY}/${receipt.id}`;
}

// ─── NFT Minting ────────────────────────────────────────────────────────────

/**
 * Creates (mints) a single NFT on Solana via the Metaplex SDK and
 * attempts to verify its collection membership.
 *
 * @param metaplex          - Initialised Metaplex SDK instance.
 * @param metadataUri       - Irys gateway URL of the metadata JSON.
 * @param name              - On-chain name for the NFT.
 * @param index             - Zero-based index (used for naming only).
 * @param total             - Total collection size (used for naming only).
 * @param collectionAddress - Public key of the collection NFT to attach to.
 * @returns The base-58 mint address of the newly created NFT.
 */
async function mintNft(
  metaplex: Metaplex,
  metadataUri: string,
  name: string,
  index: number,
  total: number,
  collectionAddress: PublicKey,
): Promise<string> {
  if (typeof metadataUri !== 'string' || metadataUri.length === 0) {
    throw new Error('metadataUri must be a non-empty string');
  }
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error('name must be a non-empty string');
  }
  if (!(collectionAddress instanceof PublicKey)) {
    throw new Error('collectionAddress must be a PublicKey instance');
  }

  log(`Minting ${name}...`);
  const { nft } = await metaplex.nfts().create({
    uri: metadataUri,
    name,
    symbol: COLLECTION_SYMBOL,
    sellerFeeBasisPoints: SELLER_FEE_BPS,
    collection: collectionAddress,
  });

  const addr = nft.address.toBase58();

  if (typeof addr !== 'string' || addr.length === 0) {
    throw new Error('Mint did not return a valid address');
  }

  log(`Minted: ${addr}`);

  try {
    await metaplex.nfts().verifyCollection({
      mintAddress: nft.address,
      collectionMintAddress: collectionAddress,
    });
    log('✓ Collection verified');
  } catch {
    log('✓ Collection verification skipped');
  }

  return addr;
}

// ─── Main Entry Point ───────────────────────────────────────────────────────

/**
 * Main orchestration function.
 *
 * **Flow:**
 * 1. Load wallet and check SOL balance (airdrop if needed).
 * 2. Load the upload cache from disk.
 * 3. **Existing-collection mode** (`COLLECTION_ADDRESS` is set in `.env`):
 *    - Reuse cached image URIs.
 *    - Ask the user for the target collection size.
 *    - Upload only metadata JSON and mint additional NFTs.
 * 4. **New-collection mode** (no `COLLECTION_ADDRESS`):
 *    - Scan `assets/` for image / video files.
 *    - Upload the collection image + metadata to Irys.
 *    - Create the collection NFT via Metaplex.
 *    - For each asset: upload image + metadata (unless cached), mint.
 * 5. Save the cache after every upload / mint step.
 * 6. Print a summary with all minted addresses and an explorer link.
 */
async function main(): Promise<void> {
  console.log('\n======================================');
  console.log('  MintForge — Solana NFT Collection');
  console.log('======================================\n');

  // ── Wallet & Connection ──────────────────────────────────────────────

  const wallet = loadWallet();
  log(`Wallet: ${wallet.publicKey.toBase58()}`);

  const connection = new Connection(RPC, 'confirmed');
  const balance = await connection.getBalance(wallet.publicKey);

  if (typeof balance !== 'number' || isNaN(balance)) {
    throw new Error('Failed to fetch wallet balance');
  }

  log(`Balance: ${balance / LAMPORTS_PER_SOL} SOL`);

  if (balance < MIN_BALANCE_SOL * LAMPORTS_PER_SOL) {
    console.log('\n⚠  Low balance. Requesting airdrop...');
    const sig = await connection.requestAirdrop(wallet.publicKey, LAMPORTS_PER_SOL);
    await connection.confirmTransaction(sig);
    const newBalance = await connection.getBalance(wallet.publicKey);

    if (typeof newBalance !== 'number' || isNaN(newBalance)) {
      throw new Error('Failed to fetch balance after airdrop');
    }

    log(`New balance: ${newBalance / LAMPORTS_PER_SOL} SOL`);
  }

  const cache = loadCache();
  const existingCount = cache.nfts?.length ?? 0;
  const metaplex = Metaplex.make(connection).use(keypairIdentity(wallet));

  // ── MODE: Add to existing collection ──────────────────────────────────

  if (IS_EXISTING_COLLECTION) {
    const collectionAddress = new PublicKey(COLLECTION_ADDRESS);

    console.log('\n📁 Mode: Add NFTs to existing collection');
    log(`Collection: ${collectionAddress.toBase58()}`);
    log(`Existing NFTs in cache: ${existingCount}`);

    /** Available image URIs from the cache (rotated for new mints). */
    const cachedUris: string[] = cache.nfts
      .map((n: NftCacheEntry) => n.image)
      .filter((uri): uri is string => typeof uri === 'string' && uri.length > 0);

    if (cachedUris.length === 0) {
      console.error('\n❌ No cached images found. Run a fresh mint first or add images to assets/.\n');
      process.exit(1);
    }

    log(`Available cached images: ${cachedUris.length}`);

    // Ask user for the total desired collection size
    const answer = await ask(
      `\n❓ Total NFTs desired in collection? (current: ${existingCount}): `,
    );
    const totalDesired = parseInt(answer, 10);

    if (isNaN(totalDesired) || typeof totalDesired !== 'number') {
      console.log('\n⚠  Invalid number. Exiting.\n');
      return;
    }
    if (totalDesired <= existingCount) {
      console.log('\n⚠  No new NFTs to mint. Exiting.\n');
      return;
    }

    const newCount = totalDesired - existingCount;

    if (typeof newCount !== 'number' || newCount < 1) {
      throw new Error('Invalid new mint count');
    }

    log(`Will mint ${newCount} new NFT(s) using cached images`);

    // Initialise Irys (metadata-only uploads)
    console.log('\n🌐 Initializing Irys (metadata only)...');
    const irys = new Irys({
      url: IRYS_NODE, token: 'solana',
      key: wallet.secretKey, config: { providerUrl: RPC },
    });

    const walletAddr = wallet.publicKey.toBase58();
    const results: NftResult[] = [];

    for (let i = 0; i < newCount; i++) {
      const nftIndex = existingCount + i;
      const cachedImage = cachedUris[i % cachedUris.length];
      const nftName = `${COLLECTION_NAME} #${nftIndex + 1}`;

      console.log(`\n--- ${nftName} ---`);

      // Generate and upload metadata (reuse cached image URI)
      const metadata = generateMetadata(nftIndex, totalDesired, cachedImage, walletAddr);
      const metadataUri = await uploadJsonToIrys(irys, metadata as unknown as Record<string, unknown>);
      log(`Metadata: ${metadataUri}`);

      // Mint
      const mintAddr = await mintNft(metaplex, metadataUri, nftName, nftIndex, totalDesired, collectionAddress);

      // Save to cache with a unique label
      cache.nfts.push({
        file: null,
        label: nftName,
        image: cachedImage,
        metadata: metadataUri,
        mintAddress: mintAddr,
      });
      cache.totalMinted = nftIndex + 1;
      saveCache(cache);

      results.push({ name: nftName, address: mintAddr, uri: metadataUri });
    }

    // Summary
    printSummary(collectionAddress, COLLECTION_NAME, results, newCount, totalDesired, NETWORK);
    return;
  }

  // ── MODE: New collection from scratch ─────────────────────────────────

  const assets = getAssets();
  if (assets.length === 0) {
    console.error('\n❌ No images found in assets/. Add images or set COLLECTION_ADDRESS in .env.\n');
    process.exit(1);
  }

  /** Whether a dedicated collection image (prefixed with "collection") exists. */
  const hasCollectionImage = assets.some((a) => a.file.toLowerCase().startsWith('collection'));
  const collectionAsset: Asset = hasCollectionImage
    ? assets.find((a) => a.file.toLowerCase().startsWith('collection'))!
    : assets[0];

  const nftAssets: Asset[] = hasCollectionImage
    ? assets.filter((a) => a !== collectionAsset)
    : assets;

  console.log(`\n📦 Assets found: ${assets.length}`);
  log(`Collection image: ${collectionAsset.file}`);
  log(`NFTs to mint: ${nftAssets.length}`);

  // Initialise Irys
  console.log('\n🌐 Initializing Irys (Arweave)...');
  const irys = new Irys({
    url: IRYS_NODE, token: 'solana',
    key: wallet.secretKey, config: { providerUrl: RPC },
  });

  // ── Upload collection image ───────────────────────────────────────────

  console.log('\n📤 Uploading collection...');
  let collectionImageUri: string;
  if (cache.collection?.image) {
    collectionImageUri = cache.collection.image;
    log('Using cached collection image');
  } else {
    collectionImageUri = await uploadToIrys(irys, path.join(ASSETS_DIR, collectionAsset.file), [
      { name: 'Content-Type', value: getMimeType(collectionAsset.ext) },
      { name: 'App-Name', value: 'MintForge' },
    ]);
    log(`Collection image: ${collectionImageUri}`);
    cache.collection = { ...(cache.collection ?? {}), image: collectionImageUri };
    saveCache(cache);
  }

  // ── Upload collection metadata ────────────────────────────────────────

  let collectionMetadataUri: string;
  if (cache.collection?.metadata) {
    collectionMetadataUri = cache.collection.metadata;
    log('Using cached collection metadata');
  } else {
    const metadata = generateMetadata(0, nftAssets.length, collectionImageUri, wallet.publicKey.toBase58(), true);
    collectionMetadataUri = await uploadJsonToIrys(irys, metadata as unknown as Record<string, unknown>);
    log(`Collection metadata: ${collectionMetadataUri}`);
    cache.collection = { ...(cache.collection ?? {}), metadata: collectionMetadataUri };
    saveCache(cache);
  }

  // ── Create collection NFT ─────────────────────────────────────────────

  console.log('\n🖼  Creating collection NFT...');
  let collectionAddress: PublicKey;
  if (cache.collection?.mintAddress) {
    collectionAddress = new PublicKey(cache.collection.mintAddress);
    log(`Using cached collection: ${collectionAddress.toBase58()}`);
  } else {
    log(`Creating collection "${COLLECTION_NAME}"...`);
    const { nft: collectionNft } = await metaplex.nfts().create({
      uri: collectionMetadataUri, name: COLLECTION_NAME,
      symbol: COLLECTION_SYMBOL, sellerFeeBasisPoints: SELLER_FEE_BPS, isCollection: true,
    });
    collectionAddress = collectionNft.address;
    log(`Collection created: ${collectionAddress.toBase58()}`);
    cache.collection = { ...(cache.collection ?? {}), mintAddress: collectionAddress.toBase58() };
    saveCache(cache);
  }

  // ── Mint individual NFTs ──────────────────────────────────────────────

  const results: NftResult[] = [];
  const walletAddr = wallet.publicKey.toBase58();
  const totalNfts = nftAssets.length;

  for (let i = 0; i < totalNfts; i++) {
    const asset = nftAssets[i];
    const cachedNft = cache.nfts.find((n: NftCacheEntry) => n.file === asset.file);

    console.log(`\n--- NFT ${i + 1}/${totalNfts}: ${asset.file} ---`);

    // Image upload (skip if cached)
    let imageUri: string;
    if (cachedNft?.image) {
      imageUri = cachedNft.image;
      log('Using cached image');
    } else {
      imageUri = await uploadToIrys(irys, path.join(ASSETS_DIR, asset.file), [
        { name: 'Content-Type', value: getMimeType(asset.ext) },
        { name: 'App-Name', value: 'MintForge' },
      ]);
      log(`Image: ${imageUri}`);
      const entry = cache.nfts.find((n: NftCacheEntry) => n.file === asset.file);
      if (entry) {
        entry.image = imageUri;
      } else {
        cache.nfts.push({ file: asset.file, image: imageUri });
      }
      saveCache(cache);
    }

    // Metadata upload (skip if cached)
    let metadataUri: string;
    if (cachedNft?.metadata) {
      metadataUri = cachedNft.metadata;
      log('Using cached metadata');
    } else {
      const metadata = generateMetadata(i, totalNfts, imageUri, walletAddr);
      metadataUri = await uploadJsonToIrys(irys, metadata as unknown as Record<string, unknown>);
      log(`Metadata: ${metadataUri}`);
      const entry = cache.nfts.find((n: NftCacheEntry) => n.file === asset.file);
      if (entry) {
        entry.metadata = metadataUri;
      } else {
        cache.nfts.push({ file: asset.file, image: imageUri, metadata: metadataUri });
      }
      saveCache(cache);
    }

    // Mint (skip if already minted)
    let mintAddr: string;
    if (cachedNft?.mintAddress) {
      mintAddr = cachedNft.mintAddress;
      log(`Already minted: ${mintAddr}`);
    } else {
      mintAddr = await mintNft(metaplex, metadataUri, `${COLLECTION_NAME} #${i + 1}`, i, totalNfts, collectionAddress);
      const entry = cache.nfts.find((n: NftCacheEntry) => n.file === asset.file);
      if (entry) {
        entry.mintAddress = mintAddr;
      }
      saveCache(cache);
    }

    results.push({ name: `${COLLECTION_NAME} #${i + 1}`, address: mintAddr, uri: metadataUri });
  }

  cache.totalMinted = results.length;
  saveCache(cache);

  printSummary(collectionAddress, COLLECTION_NAME, results, results.length, totalNfts, NETWORK);
  console.log(`Collection Metadata: ${collectionMetadataUri}`);
  console.log();
}

/**
 * Prints a formatted summary of minted NFTs and the collection explorer link.
 *
 * @param collectionAddress - The collection NFT public key.
 * @param collectionName    - Display name of the collection.
 * @param results           - Array of mint results.
 * @param mintedCount       - Number of NFTs minted in this run.
 * @param totalCount        - Total NFT count in the collection.
 * @param network           - Solana network label (devnet / mainnet-beta).
 */
function printSummary(
  collectionAddress: PublicKey,
  collectionName: string,
  results: NftResult[],
  mintedCount: number,
  totalCount: number,
  network: string,
): void {
  console.log('\n======================================');
  console.log('  ✅ Collection Complete!');
  console.log('======================================');
  console.log(`\nCollection: ${collectionName}`);
  console.log(`Collection Address: ${collectionAddress.toBase58()}`);
  console.log(`NFTs Minted: ${mintedCount}/${totalCount}`);
  console.log('\nMinted NFTs:');
  for (const r of results) {
    console.log(`  ${r.name}`);
    console.log(`    Address:  ${r.address}`);
    console.log(`    Metadata: ${r.uri}`);
  }
  console.log(`\nView in explorer:`);
  console.log(`  https://explorer.solana.com/address/${collectionAddress.toBase58()}?cluster=${network}`);
}

// ─── Bootstrap ──────────────────────────────────────────────────────────────

main().catch((err) => {
  console.error('\n❌ Script failed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
