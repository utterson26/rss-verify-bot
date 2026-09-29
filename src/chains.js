// Restless Spirits Society — multi-chain native-balance + USD pricing layer.
//
// Entry rule: a member qualifies when the NATIVE coins held across the wallets
// they prove ownership of are worth MIN_USD or more in total.
//
// "Native" means SOL, ETH and BNB — the chain's own coin. Tokens and memecoins
// are deliberately NOT counted: pricing arbitrary tokens needs a paid indexer,
// and thin-liquidity memecoins make the threshold trivially gameable (anyone can
// mint a token, seed a tiny pool, and "hold" a fake $1M).
//
// Everything here fails CLOSED: if a price feed or an RPC is unreachable we throw,
// and the caller refuses the verification rather than guessing a balance.

const TIMEOUT_MS = 9000;

// ── Chains ──────────────────────────────────────────────────────────────────
// One EVM address is checked on every EVM chain below (same address everywhere).
export const EVM_CHAINS = [
  { key: 'ethereum', name: 'Ethereum', symbol: 'ETH', priceId: 'ethereum',
    rpc: process.env.ETH_RPC_URL  || 'https://ethereum-rpc.publicnode.com' },
  { key: 'bsc', name: 'BNB Chain', symbol: 'BNB', priceId: 'binancecoin',
    rpc: process.env.BSC_RPC_URL  || 'https://bsc-rpc.publicnode.com' },
  { key: 'base', name: 'Base', symbol: 'ETH', priceId: 'ethereum',
    rpc: process.env.BASE_RPC_URL || 'https://base-rpc.publicnode.com' },
  { key: 'arbitrum', name: 'Arbitrum', symbol: 'ETH', priceId: 'ethereum',
    rpc: process.env.ARB_RPC_URL  || 'https://arbitrum-one-rpc.publicnode.com' },
];

// CoinGecko ids we need prices for.
const PRICE_IDS = ['solana', 'ethereum', 'binancecoin'];
// Binance ticker symbols used as the fallback feed.
const BINANCE_MAP = { solana: 'SOLUSDT', ethereum: 'ETHUSDT', binancecoin: 'BNBUSDT' };

function fetchJson(url, init = {}) {
  return fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) })
    .then(async (r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status} from ${new URL(url).host}`);
      return r.json();
    });
}

// ── Prices (cached; CoinGecko primary, Binance fallback) ────────────────────
const PRICE_TTL_MS = 60_000;
let priceCache = { at: 0, prices: null };

async function fromCoinGecko() {
  const key = process.env.COINGECKO_API_KEY;
  const base = key
    ? 'https://pro-api.coingecko.com/api/v3/simple/price'
    : 'https://api.coingecko.com/api/v3/simple/price';
  const url = `${base}?ids=${PRICE_IDS.join(',')}&vs_currencies=usd`;
  const headers = key ? { 'x-cg-pro-api-key': key } : {};
  const data = await fetchJson(url, { headers });
  const out = {};
  for (const id of PRICE_IDS) {
    const p = data?.[id]?.usd;
    if (typeof p !== 'number' || !(p > 0)) throw new Error(`CoinGecko returned no price for ${id}`);
    out[id] = p;
  }
  return out;
}

async function fromBinance() {
  const symbols = JSON.stringify(PRICE_IDS.map((id) => BINANCE_MAP[id]));
  const url = `https://api.binance.com/api/v3/ticker/price?symbols=${encodeURIComponent(symbols)}`;
  const rows = await fetchJson(url);
  const bySymbol = Object.fromEntries(rows.map((r) => [r.symbol, Number(r.price)]));
  const out = {};
  for (const id of PRICE_IDS) {
    const p = bySymbol[BINANCE_MAP[id]];
    if (!(p > 0)) throw new Error(`Binance returned no price for ${id}`);
    out[id] = p;
  }
  return out;
}

/** USD prices for SOL / ETH / BNB. Throws if no feed is reachable. */
export async function getPrices() {
  if (priceCache.prices && Date.now() - priceCache.at < PRICE_TTL_MS) return priceCache.prices;
  const errors = [];
  for (const [name, fn] of [['coingecko', fromCoinGecko], ['binance', fromBinance]]) {
    try {
      const prices = await fn();
      priceCache = { at: Date.now(), prices };
      return prices;
    } catch (e) { errors.push(`${name}: ${e.message}`); }
  }
  // Serve a stale cache (up to 15 min) before giving up — better than locking
  // out a legitimate holder because CoinGecko rate-limited us for a minute.
  if (priceCache.prices && Date.now() - priceCache.at < 15 * 60_000) return priceCache.prices;
  throw new Error(`No price feed available (${errors.join('; ')})`);
}

// ── EVM ─────────────────────────────────────────────────────────────────────
export function isEvmAddress(a) { return typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a); }

/** Native balance (as a Number of whole coins) for one address on one EVM chain. */
async function evmBalance(chain, address) {
  const body = { jsonrpc: '2.0', id: 1, method: 'eth_getBalance', params: [address, 'latest'] };
  const data = await fetchJson(chain.rpc, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (data?.error) throw new Error(`${chain.name} RPC: ${data.error.message}`);
  if (typeof data?.result !== 'string') throw new Error(`${chain.name} RPC returned no balance`);
  // wei → coins, keeping precision via BigInt before the final divide.
  const wei = BigInt(data.result);
  return Number(wei / 1_000_000_000n) / 1e9;
}

/**
 * Value one EVM address across every configured EVM chain.
 * A single chain being down is tolerated (recorded in `failed`); it just can't
 * contribute value. All chains failing throws.
 */
export async function valueEvmAddress(address, prices) {
  const results = await Promise.allSettled(
    EVM_CHAINS.map(async (c) => ({ chain: c, amount: await evmBalance(c, address) })),
  );
  const holdings = [];
  const failed = [];
  results.forEach((r, i) => {
    if (r.status === 'rejected') { failed.push(EVM_CHAINS[i].name); return; }
    const { chain, amount } = r.value;
    if (amount <= 0) return;
    holdings.push({
      chain: chain.name, symbol: chain.symbol, amount,
      usd: amount * prices[chain.priceId],
    });
  });
  if (failed.length === EVM_CHAINS.length) throw new Error('Every EVM RPC is unreachable right now.');
  return { holdings, failed };
}

// ── Solana ──────────────────────────────────────────────────────────────────
/** Value one Solana address (native SOL only). */
export async function valueSolanaAddress(connection, publicKey, prices) {
  const lamports = await connection.getBalance(publicKey, 'confirmed');
  const amount = lamports / 1_000_000_000;
  const holdings = amount > 0
    ? [{ chain: 'Solana', symbol: 'SOL', amount, usd: amount * prices.solana }]
    : [];
  return { holdings, failed: [] };
}

export function totalUsd(holdings) {
  return holdings.reduce((sum, h) => sum + h.usd, 0);
}

/** "0.42 SOL ($91.20)" style summary, biggest holding first. */
export function describeHoldings(holdings) {
  return [...holdings]
    .sort((a, b) => b.usd - a.usd)
    .map((h) => `${trim(h.amount)} ${h.symbol} on ${h.chain} ($${h.usd.toFixed(2)})`)
    .join(', ');
}

function trim(n) {
  if (n >= 1000) return n.toFixed(0);
  if (n >= 1) return n.toFixed(3);
  return n.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
}
