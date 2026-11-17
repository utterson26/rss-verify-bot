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

// Internal price ids (CoinGecko naming, kept for compatibility).
const PRICE_IDS = ['solana', 'ethereum', 'binancecoin'];
const SYMBOL = { solana: 'SOL', ethereum: 'ETH', binancecoin: 'BNB' };

function fetchJson(url, init = {}) {
  return fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) })
    .then(async (r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status} from ${new URL(url).host}`);
      return r.json();
    });
}

// ── Prices ──────────────────────────────────────────────────────────────────
// Several independent sources, tried in order; each may return a PARTIAL map
// and the results are merged until every coin has a price. This matters in
// practice: from a US datacenter CoinGecko rate-limits (429) and Binance
// geo-blocks (451), so no single source is safe to depend on.
//
// Every source returns { solana?: usd, ethereum?: usd, binancecoin?: usd }.

const positive = (n) => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : undefined);

// Coinbase: one call returns units-per-USD for hundreds of assets; invert it.
// US-based, no key, generous limits — the primary source.
async function fromCoinbase() {
  const data = await fetchJson('https://api.coinbase.com/v2/exchange-rates?currency=USD');
  const rates = data?.data?.rates ?? {};
  const out = {};
  for (const id of PRICE_IDS) {
    const perUsd = Number(rates[SYMBOL[id]]);
    if (perUsd > 0) out[id] = positive(1 / perUsd);
  }
  return out;
}

// Binance.US: separate entity from Binance global, reachable from US hosts.
async function fromBinanceUS() {
  const symbols = encodeURIComponent(JSON.stringify(PRICE_IDS.map((id) => `${SYMBOL[id]}USD`)));
  const rows = await fetchJson(`https://api.binance.us/api/v3/ticker/price?symbols=${symbols}`);
  const bySymbol = Object.fromEntries((rows ?? []).map((r) => [r.symbol, Number(r.price)]));
  const out = {};
  for (const id of PRICE_IDS) out[id] = positive(bySymbol[`${SYMBOL[id]}USD`]);
  return out;
}

async function fromCoinGecko() {
  const key = process.env.COINGECKO_API_KEY;
  const base = key
    ? 'https://pro-api.coingecko.com/api/v3/simple/price'
    : 'https://api.coingecko.com/api/v3/simple/price';
  const headers = key ? { 'x-cg-pro-api-key': key } : {};
  const data = await fetchJson(`${base}?ids=${PRICE_IDS.join(',')}&vs_currencies=usd`, { headers });
  const out = {};
  for (const id of PRICE_IDS) out[id] = positive(data?.[id]?.usd);
  return out;
}

// Kraken lists SOL and ETH but not BNB — a partial source, which the merge handles.
async function fromKraken() {
  const data = await fetchJson('https://api.kraken.com/0/public/Ticker?pair=SOLUSD,ETHUSD');
  if (data?.error?.length) throw new Error(data.error.join(', '));
  const out = {};
  for (const [pair, t] of Object.entries(data?.result ?? {})) {
    const last = Number(t?.c?.[0]);
    if (/SOL/.test(pair)) out.solana = positive(last);
    else if (/ETH/.test(pair)) out.ethereum = positive(last);
  }
  return out;
}

// Binance global — blocked from US IPs, useful if the bot is ever hosted elsewhere.
async function fromBinance() {
  const symbols = encodeURIComponent(JSON.stringify(PRICE_IDS.map((id) => `${SYMBOL[id]}USDT`)));
  const rows = await fetchJson(`https://api.binance.com/api/v3/ticker/price?symbols=${symbols}`);
  const bySymbol = Object.fromEntries((rows ?? []).map((r) => [r.symbol, Number(r.price)]));
  const out = {};
  for (const id of PRICE_IDS) out[id] = positive(bySymbol[`${SYMBOL[id]}USDT`]);
  return out;
}

export const PRICE_SOURCES = [
  ['coinbase', fromCoinbase],
  ['binance.us', fromBinanceUS],
  ['coingecko', fromCoinGecko],
  ['kraken', fromKraken],
  ['binance', fromBinance],
];

const PRICE_TTL_MS = 60_000;
const STALE_OK_MS = 30 * 60_000;
let priceCache = { at: 0, prices: null };

/** USD prices for SOL / ETH / BNB. Throws if the coins can't all be priced. */
export async function getPrices() {
  if (priceCache.prices && Date.now() - priceCache.at < PRICE_TTL_MS) return priceCache.prices;
  const prices = {};
  const errors = [];
  for (const [name, fn] of PRICE_SOURCES) {
    try {
      const got = await fn();
      for (const id of PRICE_IDS) if (prices[id] === undefined && got[id] !== undefined) prices[id] = got[id];
    } catch (e) { errors.push(`${name}: ${e.message}`); }
    if (PRICE_IDS.every((id) => prices[id] !== undefined)) {
      priceCache = { at: Date.now(), prices };
      return prices;
    }
  }
  // Serve a stale cache (up to 30 min) before giving up — better than locking
  // out a legitimate holder because the feeds hiccuped for a minute.
  if (priceCache.prices && Date.now() - priceCache.at < STALE_OK_MS) return priceCache.prices;
  const missing = PRICE_IDS.filter((id) => prices[id] === undefined).map((id) => SYMBOL[id]);
  throw new Error(`No price for ${missing.join(', ')} (${errors.join('; ') || 'sources returned nothing'})`);
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
