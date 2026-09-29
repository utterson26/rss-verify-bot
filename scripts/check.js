// Live pre-flight: are the price feed and every chain RPC actually reachable
// from wherever this is deployed? Run with `npm run check`.
//
// Optionally pass wallets to value them for real:
//   node scripts/check.js 0xd8dA…6045 7xKX…gAsU

import 'dotenv/config';
import { Connection, PublicKey } from '@solana/web3.js';
import {
  EVM_CHAINS, getPrices, isEvmAddress,
  valueEvmAddress, valueSolanaAddress, totalUsd, describeHoldings,
} from '../src/chains.js';

const MIN_USD = Number(process.env.MIN_USD ?? 1000);
const RPC_URL = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
let failures = 0;

const pass = (m) => console.log(`  ✅ ${m}`);
const fail = (m) => { failures++; console.log(`  ❌ ${m}`); };

console.log(`\nRSS verify bot — live check (threshold $${MIN_USD.toLocaleString('en-US')})\n`);

// 1) Prices
console.log('Price feed');
let prices;
try {
  const t0 = Date.now();
  prices = await getPrices();
  pass(`SOL $${prices.solana} · ETH $${prices.ethereum} · BNB $${prices.binancecoin}  (${Date.now() - t0}ms)`);
} catch (e) {
  fail(`no price feed reachable — ${e.message}`);
  console.log('\nWithout prices the bot refuses every verification. Fix this before opening the doors.\n');
  process.exit(1);
}

// 2) EVM RPCs
console.log('\nEVM RPCs');
const probe = '0x0000000000000000000000000000000000000000';
for (const chain of EVM_CHAINS) {
  const t0 = Date.now();
  try {
    const r = await fetch(chain.rpc, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getBalance', params: [probe, 'latest'] }),
      signal: AbortSignal.timeout(9000),
    });
    const data = await r.json();
    if (data?.error) throw new Error(data.error.message);
    if (typeof data?.result !== 'string') throw new Error('no result field');
    pass(`${chain.name.padEnd(11)} ${chain.symbol.padEnd(4)} ${new URL(chain.rpc).host} (${Date.now() - t0}ms)`);
  } catch (e) {
    fail(`${chain.name.padEnd(11)} ${new URL(chain.rpc).host} — ${e.message}`);
  }
}

// 3) Solana RPC
console.log('\nSolana RPC');
const connection = new Connection(RPC_URL, 'confirmed');
try {
  const t0 = Date.now();
  await connection.getEpochInfo();
  pass(`${new URL(RPC_URL).host} (${Date.now() - t0}ms)`);
} catch (e) {
  fail(`${new URL(RPC_URL).host} — ${e.message}`);
}

// 4) Optional: value real wallets
const wallets = process.argv.slice(2);
if (wallets.length) {
  console.log('\nWallets');
  const holdings = [];
  for (const w of wallets) {
    try {
      const r = isEvmAddress(w)
        ? await valueEvmAddress(w, prices)
        : await valueSolanaAddress(connection, new PublicKey(w), prices);
      holdings.push(...r.holdings);
      pass(`${w}\n     ${describeHoldings(r.holdings) || '(nothing)'}`);
      if (r.failed.length) console.log(`     ⚠  couldn't reach ${r.failed.join(', ')}`);
    } catch (e) {
      fail(`${w} — ${e.message}`);
    }
  }
  const total = totalUsd(holdings);
  console.log(`\n  Total: $${total.toFixed(2)} → ${total >= MIN_USD - 0.01 ? 'QUALIFIES ✅' : 'below the threshold ❌'}`);
}

console.log(
  failures === 0
    ? '\nAll good — the bot can value wallets from here.\n'
    : `\n${failures} check(s) failed. Members on those chains can't be counted until they're fixed.\n`,
);
process.exit(failures === 0 ? 0 : 1);
