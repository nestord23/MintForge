import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, clusterApiUrl } from '@solana/web3.js';
import { Metaplex, keypairIdentity } from '@metaplex-foundation/js';
import Irys from '@irys/sdk';
import { fileURLToPath } from 'url';

dotenv.config();

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

const IS_EXISTING_COLLECTION = COLLECTION_ADDRESS.length > 0;

function log(msg: string): void {
  console.log(`  ${msg}`);
}

function ask(query: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(query, (answer) => { rl.close(); resolve(answer.trim()); });
  });
}

function loadWallet(): Keypair {
  if (!fs.existsSync(KEYPAIR_PATH)) {
    console.error('\n❌ No wallet found. Run `pnpm setup` first.\n');
    process.exit(1);
  }
  const data = JSON.parse(fs.readFileSync(KEYPAIR_PATH, 'utf-8'));
  return Keypair.fromSecretKey(new Uint8Array(data));
}

function getAssets(): { file: string; ext: string }[] {
  if (!fs.existsSync(ASSETS_DIR)) {
    fs.mkdirSync(ASSETS_DIR, { recursive: true });
    return [];
  }
  const validExts = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.mp4']);
  return fs.readdirSync(ASSETS_DIR)
    .filter((f) => validExts.has(path.extname(f).toLowerCase()))
    .map((f) => ({ file: f, ext: path.extname(f).toLowerCase() }))
    .sort((a, b) => a.file.localeCompare(b.file));
}

function getMimeType(ext: string): string {
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

function loadCache(): Record<string, any> {
  if (fs.existsSync(CACHE_PATH)) {
    return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf-8'));
  }
  return { collection: null, nfts: [], totalMinted: 0 };
}

function saveCache(cache: Record<string, any>): void {
  fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
}

function generateAttributes(index: number, total: number): { trait_type: string; value: string }[] {
  const rarities = ['Common', 'Uncommon', 'Rare', 'Epic', 'Legendary'];
  const rarity = rarities[index % rarities.length];
  return [
    { trait_type: 'Edition', value: `#${index + 1}` },
    { trait_type: 'Rarity', value: rarity },
    { trait_type: 'Collection Size', value: `${total}` },
  ];
}

function generateMetadata(
  index: number,
  total: number,
  imageUri: string,
  walletAddress: string,
  isCollection: boolean = false
): Record<string, any> {
  if (isCollection) {
    return {
      name: COLLECTION_NAME,
      symbol: COLLECTION_SYMBOL,
      description: COLLECTION_DESCRIPTION,
      image: imageUri,
      properties: {
        files: [{ uri: imageUri, type: getMimeType(path.extname(imageUri) || '.png') }],
        category: 'image',
        creators: [{ address: walletAddress, share: 100 }],
      },
    };
  }
  return {
    name: `${COLLECTION_NAME} #${index + 1}`,
    symbol: COLLECTION_SYMBOL,
    description: COLLECTION_DESCRIPTION,
    seller_fee_basis_points: 500,
    image: imageUri,
    attributes: generateAttributes(index, total),
    properties: {
      files: [{ uri: imageUri, type: getMimeType(path.extname(imageUri) || '.png') }],
      category: 'image',
      creators: [{ address: walletAddress, share: 100 }],
    },
  };
}

async function uploadToIrys(irys: Irys, filePath: string, tags: { name: string; value: string }[]): Promise<string> {
  const fileSize = fs.statSync(filePath).size;
  const price = await irys.getPrice(fileSize);
  const balance = await irys.getLoadedBalance();
  if (price.isGreaterThan(balance)) {
    const amount = price.minus(balance).multipliedBy(1.5).integerValue();
    log(`Funding Irys with ${amount.dividedBy(LAMPORTS_PER_SOL).toFixed(6)} SOL...`);
    try { await irys.fund(amount); } catch (e: any) { log(`Fund warning: ${e.message || e}`); }
  }
  const receipt = await irys.uploadFile(filePath, { tags });
  return `${IRYS_GATEWAY}/${receipt.id}`;
}

async function uploadJsonToIrys(irys: Irys, data: Record<string, any>): Promise<string> {
  const json = JSON.stringify(data);
  const fileSize = Buffer.byteLength(json);
  const price = await irys.getPrice(fileSize);
  const balance = await irys.getLoadedBalance();
  if (price.isGreaterThan(balance)) {
    const amount = price.minus(balance).multipliedBy(1.5).integerValue();
    log(`Funding Irys metadata upload...`);
    try { await irys.fund(amount); } catch (e: any) { log(`Fund warning: ${e.message || e}`); }
  }
  const receipt = await irys.upload(json, {
    tags: [{ name: 'Content-Type', value: 'application/json' }],
  });
  return `${IRYS_GATEWAY}/${receipt.id}`;
}

async function mintNft(
  metaplex: Metaplex,
  metadataUri: string,
  name: string,
  index: number,
  total: number,
  collectionAddress: PublicKey
): Promise<string> {
  log(`Minting ${name}...`);
  const { nft } = await metaplex.nfts().create({
    uri: metadataUri,
    name,
    symbol: COLLECTION_SYMBOL,
    sellerFeeBasisPoints: 500,
    collection: collectionAddress,
  });
  const addr = nft.address.toBase58();
  log(`Minted: ${addr}`);

  try {
    await metaplex.nfts().verifyCollection({
      mintAddress: nft.address,
      collectionMintAddress: collectionAddress,
    });
    log(`✓ Collection verified`);
  } catch {
    log(`✓ Collection verification skipped`);
  }

  return addr;
}

async function main(): Promise<void> {
  console.log('\n======================================');
  console.log('  MintForge — Solana NFT Collection');
  console.log('======================================\n');

  const wallet = loadWallet();
  log(`Wallet: ${wallet.publicKey.toBase58()}`);

  const connection = new Connection(RPC, 'confirmed');
  const balance = await connection.getBalance(wallet.publicKey);
  log(`Balance: ${balance / LAMPORTS_PER_SOL} SOL`);

  if (balance < 0.01 * LAMPORTS_PER_SOL) {
    console.log('\n⚠  Low balance. Requesting airdrop...');
    const sig = await connection.requestAirdrop(wallet.publicKey, LAMPORTS_PER_SOL);
    await connection.confirmTransaction(sig);
    log(`New balance: ${(await connection.getBalance(wallet.publicKey)) / LAMPORTS_PER_SOL} SOL`);
  }

  const cache = loadCache();
  const existingCount = cache.nfts?.length || 0;
  const metaplex = Metaplex.make(connection).use(keypairIdentity(wallet));

  // ─── MODE: Add to existing collection ───────────────────────────────
  if (IS_EXISTING_COLLECTION) {
    const collectionAddress = new PublicKey(COLLECTION_ADDRESS);
    console.log(`\n📁 Mode: Add NFTs to existing collection`);
    log(`Collection: ${collectionAddress.toBase58()}`);
    log(`Existing NFTs in cache: ${existingCount}`);

    // Determine available image URIs from cache
    const cachedUris = cache.nfts
      .map((n: any) => n.image)
      .filter(Boolean);

    if (cachedUris.length === 0) {
      console.error('\n❌ No cached images found. Run a fresh mint first or add images to assets/.\n');
      process.exit(1);
    }

    log(`Available cached images: ${cachedUris.length}`);

    // Ask user for total desired NFTs
    const answer = await ask(
      `\n❓ Total NFTs desired in collection? (current: ${existingCount}): `
    );
    const totalDesired = parseInt(answer, 10);
    if (isNaN(totalDesired) || totalDesired <= existingCount) {
      console.log('\n⚠  No new NFTs to mint. Exiting.\n');
      return;
    }
    const newCount = totalDesired - existingCount;
    log(`Will mint ${newCount} new NFT(s) using cached images`);

    // Initialize Irys (only metadata uploads needed)
    console.log('\n🌐 Initializing Irys (metadata only)...');
    const irys = new Irys({
      url: IRYS_NODE, token: 'solana',
      key: wallet.secretKey, config: { providerUrl: RPC },
    });

    const walletAddr = wallet.publicKey.toBase58();
    const results: { name: string; address: string; uri: string }[] = [];

    for (let i = 0; i < newCount; i++) {
      const nftIndex = existingCount + i;
      const cachedImage = cachedUris[i % cachedUris.length];
      const nftName = `${COLLECTION_NAME} #${nftIndex + 1}`;

      console.log(`\n--- ${nftName} ---`);

      // Generate and upload metadata (reuse cached image URI)
      const metadata = generateMetadata(nftIndex, totalDesired, cachedImage, walletAddr);
      const metadataUri = await uploadJsonToIrys(irys, metadata);
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
    console.log('\n======================================');
    console.log('  ✅ NFTs Added to Collection!');
    console.log('======================================');
    console.log(`\nCollection: ${COLLECTION_NAME}`);
    console.log(`Collection Address: ${collectionAddress.toBase58()}`);
    console.log(`New NFTs Minted: ${newCount}`);
    console.log(`Total in Collection: ${totalDesired}`);
    console.log(`\nMinted NFTs:`);
    for (const r of results) {
      console.log(`  ${r.name}`);
      console.log(`    Address:  ${r.address}`);
      console.log(`    Metadata: ${r.uri}`);
    }
    console.log(`\nView in explorer:`);
    console.log(`  https://explorer.solana.com/address/${collectionAddress.toBase58()}?cluster=${NETWORK}`);
    console.log();
    return;
  }

  // ─── MODE: New collection from scratch ──────────────────────────────
  const assets = getAssets();
  if (assets.length === 0) {
    console.error('\n❌ No images found in assets/. Add images or set COLLECTION_ADDRESS in .env.\n');
    process.exit(1);
  }

  const hasCollectionImage = assets.some((a) => a.file.toLowerCase().startsWith('collection'));
  const collectionAsset = hasCollectionImage
    ? assets.find((a) => a.file.toLowerCase().startsWith('collection'))!
    : assets[0];

  const nftAssets = hasCollectionImage
    ? assets.filter((a) => a !== collectionAsset)
    : assets;

  console.log(`\n📦 Assets found: ${assets.length}`);
  log(`Collection image: ${collectionAsset.file}`);
  log(`NFTs to mint: ${nftAssets.length}`);

  // Initialize Irys
  console.log('\n🌐 Initializing Irys (Arweave)...');
  const irys = new Irys({
    url: IRYS_NODE, token: 'solana',
    key: wallet.secretKey, config: { providerUrl: RPC },
  });

  // Upload collection image + metadata
  console.log('\n📤 Uploading collection...');
  let collectionImageUri: string;
  if (cache.collection?.image) {
    collectionImageUri = cache.collection.image;
    log(`Using cached collection image`);
  } else {
    collectionImageUri = await uploadToIrys(irys, path.join(ASSETS_DIR, collectionAsset.file), [
      { name: 'Content-Type', value: getMimeType(collectionAsset.ext) },
      { name: 'App-Name', value: 'MintForge' },
    ]);
    log(`Collection image: ${collectionImageUri}`);
    cache.collection = { ...cache.collection, image: collectionImageUri };
    saveCache(cache);
  }

  let collectionMetadataUri: string;
  if (cache.collection?.metadata) {
    collectionMetadataUri = cache.collection.metadata;
    log(`Using cached collection metadata`);
  } else {
    const metadata = generateMetadata(0, nftAssets.length, collectionImageUri, wallet.publicKey.toBase58(), true);
    collectionMetadataUri = await uploadJsonToIrys(irys, metadata);
    log(`Collection metadata: ${collectionMetadataUri}`);
    cache.collection = { ...cache.collection, metadata: collectionMetadataUri };
    saveCache(cache);
  }

  // Create collection NFT
  console.log('\n🖼  Creating collection NFT...');
  let collectionAddress: PublicKey;
  if (cache.collection?.mintAddress) {
    collectionAddress = new PublicKey(cache.collection.mintAddress);
    log(`Using cached collection: ${collectionAddress.toBase58()}`);
  } else {
    log(`Creating collection "${COLLECTION_NAME}"...`);
    const { nft: collectionNft } = await metaplex.nfts().create({
      uri: collectionMetadataUri, name: COLLECTION_NAME,
      symbol: COLLECTION_SYMBOL, sellerFeeBasisPoints: 500, isCollection: true,
    });
    collectionAddress = collectionNft.address;
    log(`Collection created: ${collectionAddress.toBase58()}`);
    cache.collection = { ...cache.collection, mintAddress: collectionAddress.toBase58() };
    saveCache(cache);
  }

  // Mint NFTs
  const results: { name: string; address: string; uri: string }[] = [];
  const walletAddr = wallet.publicKey.toBase58();
  const totalNfts = nftAssets.length;

  for (let i = 0; i < totalNfts; i++) {
    const asset = nftAssets[i];
    const cachedNft = cache.nfts.find((n: any) => n.file === asset.file);

    console.log(`\n--- NFT ${i + 1}/${totalNfts}: ${asset.file} ---`);

    let imageUri: string;
    if (cachedNft?.image) {
      imageUri = cachedNft.image;
      log(`Using cached image`);
    } else {
      imageUri = await uploadToIrys(irys, path.join(ASSETS_DIR, asset.file), [
        { name: 'Content-Type', value: getMimeType(asset.ext) },
        { name: 'App-Name', value: 'MintForge' },
      ]);
      log(`Image: ${imageUri}`);
      const entry = cache.nfts.find((n: any) => n.file === asset.file);
      if (entry) entry.image = imageUri;
      else cache.nfts.push({ file: asset.file, image: imageUri });
      saveCache(cache);
    }

    let metadataUri: string;
    if (cachedNft?.metadata) {
      metadataUri = cachedNft.metadata;
      log(`Using cached metadata`);
    } else {
      const metadata = generateMetadata(i, totalNfts, imageUri, walletAddr);
      metadataUri = await uploadJsonToIrys(irys, metadata);
      log(`Metadata: ${metadataUri}`);
      const entry = cache.nfts.find((n: any) => n.file === asset.file);
      if (entry) entry.metadata = metadataUri;
      else cache.nfts.push({ file: asset.file, image: imageUri, metadata: metadataUri });
      saveCache(cache);
    }

    let mintAddr: string;
    if (cachedNft?.mintAddress) {
      mintAddr = cachedNft.mintAddress;
      log(`Already minted: ${mintAddr}`);
    } else {
      mintAddr = await mintNft(metaplex, metadataUri, `${COLLECTION_NAME} #${i + 1}`, i, totalNfts, collectionAddress);
      const entry = cache.nfts.find((n: any) => n.file === asset.file);
      if (entry) entry.mintAddress = mintAddr;
      saveCache(cache);
    }

    results.push({ name: `${COLLECTION_NAME} #${i + 1}`, address: mintAddr, uri: metadataUri });
  }

  cache.totalMinted = results.length;
  saveCache(cache);

  console.log('\n======================================');
  console.log('  ✅ Collection Complete!');
  console.log('======================================');
  console.log(`\nCollection: ${COLLECTION_NAME}`);
  console.log(`Collection Address: ${collectionAddress.toBase58()}`);
  console.log(`Collection Metadata: ${collectionMetadataUri}`);
  console.log(`NFTs Minted: ${results.length}/${totalNfts}`);
  console.log(`\nMinted NFTs:`);
  for (const r of results) {
    console.log(`  ${r.name}`);
    console.log(`    Address:  ${r.address}`);
    console.log(`    Metadata: ${r.uri}`);
  }
  console.log(`\nView in explorer:`);
  console.log(`  https://explorer.solana.com/address/${collectionAddress.toBase58()}?cluster=${NETWORK}`);
  console.log();
}

main().catch((err) => {
  console.error('\n❌ Script failed:', err.message || err);
  process.exit(1);
});
