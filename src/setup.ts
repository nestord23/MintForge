import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { Connection, Keypair, LAMPORTS_PER_SOL, clusterApiUrl } from '@solana/web3.js';
import { fileURLToPath } from 'url';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function loadEnv(): Record<string, string> {
  return {
    RPC: process.env.SOLANA_RPC || clusterApiUrl('devnet'),
    NETWORK: process.env.SOLANA_NETWORK || 'devnet',
    KEYPAIR_PATH: path.resolve(ROOT, process.env.KEYPAIR_PATH || './keypair.json'),
  };
}

function createDirectories(): void {
  const dirs = ['assets', 'cache'];
  for (const dir of dirs) {
    const dirPath = path.join(ROOT, dir);
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
      console.log(`  ✓ Created directory: ${dir}/`);
    } else {
      console.log(`  ✓ Directory exists: ${dir}/`);
    }
  }
}

function loadOrCreateWallet(keypairPath: string): Keypair {
  if (fs.existsSync(keypairPath)) {
    const data = JSON.parse(fs.readFileSync(keypairPath, 'utf-8'));
    const keypair = Keypair.fromSecretKey(new Uint8Array(data));
    console.log(`  ✓ Wallet loaded: ${keypair.publicKey.toBase58()}`);
    return keypair;
  }

  const keypair = Keypair.generate();
  fs.writeFileSync(keypairPath, JSON.stringify(Array.from(keypair.secretKey)));
  console.log(`  ✓ New wallet created: ${keypair.publicKey.toBase58()}`);
  console.log(`  ✓ Saved to: ${keypairPath}`);
  return keypair;
}

async function requestAirdrop(connection: Connection, wallet: Keypair): Promise<void> {
  const balance = await connection.getBalance(wallet.publicKey);
  const balanceInSol = balance / LAMPORTS_PER_SOL;
  console.log(`  ℹ Current balance: ${balanceInSol} SOL`);

  if (balanceInSol >= 0.5) {
    console.log('  ✓ Balance sufficient, no airdrop needed');
    return;
  }

  console.log('  ⏳ Requesting airdrop (2 SOL)...');
  const sig = await connection.requestAirdrop(wallet.publicKey, 2 * LAMPORTS_PER_SOL);
  await connection.confirmTransaction(sig);
  const newBalance = await connection.getBalance(wallet.publicKey);
  console.log(`  ✓ Airdrop received! New balance: ${newBalance / LAMPORTS_PER_SOL} SOL`);
}

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
  console.error('\n❌ Setup failed:', err);
  process.exit(1);
});
