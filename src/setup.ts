/**
 * MintForge — Setup Script
 *
 * One-time initialization for the MintForge Solana NFT toolkit.
 * Creates required directories, loads or generates a Solana wallet,
 * and requests a devnet airdrop if the balance is low.
 *
 * Usage:  pnpm setup
 *         tsx src/setup.ts
 */

import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { Connection, Keypair, LAMPORTS_PER_SOL, clusterApiUrl } from '@solana/web3.js';
import { fileURLToPath } from 'url';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

/** Minimum SOL balance threshold before requesting an airdrop. */
const MIN_BALANCE_SOL = 0.5;
/** Amount of SOL to request in the airdrop. */
const AIRDROP_AMOUNT_SOL = 2;

/**
 * Environment configuration shape resolved from `.env` or defaults.
 */
interface EnvConfig {
  /** Solana JSON RPC URL (e.g. devnet, mainnet-beta). */
  RPC: string;
  /** Network label used for the explorer link (devnet / mainnet-beta). */
  NETWORK: string;
  /** Absolute path to the keypair JSON file. */
  KEYPAIR_PATH: string;
}

/**
 * Loads environment configuration from `.env` with sensible fallbacks.
 *
 * Reads `SOLANA_RPC`, `SOLANA_NETWORK` and `KEYPAIR_PATH` from
 * `process.env`.  If a variable is missing, a default value is used
 * (devnet RPC, `devnet` network, `./keypair.json` relative to the
 * project root).
 *
 * @returns A validated {@link EnvConfig} object.
 */
function loadEnv(): EnvConfig {
  const rpc = process.env.SOLANA_RPC || clusterApiUrl('devnet');
  const network = process.env.SOLANA_NETWORK || 'devnet';
  const keypairPath = path.resolve(ROOT, process.env.KEYPAIR_PATH || './keypair.json');

  if (typeof rpc !== 'string' || rpc.length === 0) {
    throw new Error('Invalid or missing SOLANA_RPC environment variable');
  }
  if (typeof network !== 'string' || network.length === 0) {
    throw new Error('Invalid or missing SOLANA_NETWORK environment variable');
  }
  if (typeof keypairPath !== 'string' || keypairPath.length === 0) {
    throw new Error('Invalid KEYPAIR_PATH');
  }

  return { RPC: rpc, NETWORK: network, KEYPAIR_PATH: keypairPath };
}

/**
 * Creates the `assets/` and `cache/` directories inside the project root
 * if they do not already exist.  Logs the result of each operation.
 */
function createDirectories(): void {
  const dirs = ['assets', 'cache'];

  if (!Array.isArray(dirs)) {
    throw new Error('Internal error: dirs is not an array');
  }

  for (const dir of dirs) {
    if (typeof dir !== 'string') continue;
    const dirPath = path.join(ROOT, dir);
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
      console.log(`  ✓ Created directory: ${dir}/`);
    } else {
      console.log(`  ✓ Directory exists: ${dir}/`);
    }
  }
}

/**
 * Loads an existing Solana keypair from disk, or generates a new one.
 *
 * If the file at `keypairPath` exists, it is parsed as a JSON array of
 * 64 bytes (Uint8Array) and used to restore the keypair.  Otherwise a
 * fresh keypair is created and saved to the same path.
 *
 * @param keypairPath - Absolute path to the keypair JSON file.
 * @returns A Solana {@link Keypair} instance.
 */
function loadOrCreateWallet(keypairPath: string): Keypair {
  if (typeof keypairPath !== 'string' || keypairPath.length === 0) {
    throw new Error('keypairPath must be a non-empty string');
  }

  if (fs.existsSync(keypairPath)) {
    const raw = fs.readFileSync(keypairPath, 'utf-8');
    const data = JSON.parse(raw);

    if (!Array.isArray(data) || data.length === 0) {
      throw new Error(`Invalid keypair file: expected a non-empty array at ${keypairPath}`);
    }

    const secretKey = new Uint8Array(data);
    const keypair = Keypair.fromSecretKey(secretKey);
    console.log(`  ✓ Wallet loaded: ${keypair.publicKey.toBase58()}`);
    return keypair;
  }

  const keypair = Keypair.generate();
  const secretArray = Array.from(keypair.secretKey);

  if (!Array.isArray(secretArray)) {
    throw new Error('Failed to serialize new keypair secret key');
  }

  fs.writeFileSync(keypairPath, JSON.stringify(secretArray));
  console.log(`  ✓ New wallet created: ${keypair.publicKey.toBase58()}`);
  console.log(`  ✓ Saved to: ${keypairPath}`);
  return keypair;
}

/**
 * Checks the wallet balance and requests a devnet airdrop if it is below
 * the minimum threshold.
 *
 * @param connection - A Solana RPC connection.
 * @param wallet     - The wallet keypair to fund.
 */
async function requestAirdrop(connection: Connection, wallet: Keypair): Promise<void> {
  const balance = await connection.getBalance(wallet.publicKey);
  const balanceInSol = balance / LAMPORTS_PER_SOL;

  if (typeof balance !== 'number' || isNaN(balance)) {
    throw new Error('Failed to fetch valid wallet balance');
  }

  console.log(`  ℹ Current balance: ${balanceInSol} SOL`);

  if (balanceInSol >= MIN_BALANCE_SOL) {
    console.log('  ✓ Balance sufficient, no airdrop needed');
    return;
  }

  console.log(`  ⏳ Requesting airdrop (${AIRDROP_AMOUNT_SOL} SOL)...`);
  const sig = await connection.requestAirdrop(wallet.publicKey, AIRDROP_AMOUNT_SOL * LAMPORTS_PER_SOL);
  await connection.confirmTransaction(sig);
  const newBalance = await connection.getBalance(wallet.publicKey);

  if (typeof newBalance !== 'number' || isNaN(newBalance)) {
    throw new Error('Failed to fetch balance after airdrop');
  }

  console.log(`  ✓ Airdrop received! New balance: ${newBalance / LAMPORTS_PER_SOL} SOL`);
}

/**
 * Entry point for the setup process.
 *
 * Orchestrates: environment loading → directory creation → wallet
 * loading/creation → Solana connection → balance check → optional
 * airdrop → summary output.
 */
async function main(): Promise<void> {
  console.log('\n🚀 MintForge - Setup\n');

  const env = loadEnv();

  console.log('📁 Creating directories...');
  createDirectories();

  console.log('🔑 Loading/Creating wallet...');
  const wallet = loadOrCreateWallet(env.KEYPAIR_PATH);

  console.log('🌐 Connecting to Solana...');
  const connection = new Connection(env.RPC, 'confirmed');

  console.log('💎 Requesting airdrop...');
  await requestAirdrop(connection, wallet);

  console.log('\n✅ Setup complete!');
  console.log(`   Wallet: ${wallet.publicKey.toBase58()}`);
  const balance = await connection.getBalance(wallet.publicKey);
  console.log(`   Balance: ${balance / LAMPORTS_PER_SOL} SOL`);
  console.log('\n📝 Next steps:');
  console.log('   1. Add your images to the assets/ folder');
  console.log('   2. Run: pnpm start\n');
}

main().catch((err) => {
  console.error('\n❌ Setup failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
