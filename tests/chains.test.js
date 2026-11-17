// Balance aggregation and USD maths, with fetch stubbed out.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EVM_CHAINS, isEvmAddress, valueEvmAddress, valueSolanaAddress,
  totalUsd, describeHoldings, getPrices,
} from '../src/chains.js';

const PRICES = { solana: 200, ethereum: 4000, binancecoin: 600 };
const realFetch = globalThis.fetch;

/** Stub fetch: `balances` maps an RPC host to a balance in whole coins (or 'fail'). */
function stubRpc(balances) {
  globalThis.fetch = async (url) => {
    const host = new URL(url).host;
    const value = balances[host];
    if (value === 'fail') throw new Error('connection refused');
    const wei = BigInt(Math.round((value ?? 0) * 1e9)) * 1_000_000_000n;
    return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result: '0x' + wei.toString(16) }) };
  };
}
const hostOf = (key) => new URL(EVM_CHAINS.find((c) => c.key === key).rpc).host;

test.afterEach(() => { globalThis.fetch = realFetch; });

test('isEvmAddress accepts real addresses and rejects everything else', () => {
  assert.ok(isEvmAddress('0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'));
  assert.ok(isEvmAddress('0x' + '0'.repeat(40)));
  for (const bad of ['0x123', 'd8dA6BF26964aF9D7eEd9e03E53415D37aA96045', '0x' + 'z'.repeat(40), '', null, 5]) {
    assert.equal(isEvmAddress(bad), false, `should reject ${JSON.stringify(bad)}`);
  }
});

test('one EVM address is valued across every configured chain', async () => {
  stubRpc({ [hostOf('ethereum')]: 0.075, [hostOf('bsc')]: 0.5, [hostOf('base')]: 0, [hostOf('arbitrum')]: 0 });
  const { holdings, failed } = await valueEvmAddress('0x' + '1'.repeat(40), PRICES);
  assert.equal(failed.length, 0);
  // 0.075 ETH * 4000 = 300, 0.5 BNB * 600 = 300. Zero balances are dropped.
  assert.equal(holdings.length, 2);
  assert.equal(Math.round(totalUsd(holdings)), 600);
});

// The server accepts at MIN_USD less a one-cent tolerance; mirror that here.
const qualifies = (total, min = 1000) => total >= min - 0.01;

test("the user's example clears the bar: $500 SOL + $300 ETH + $200 BNB", async () => {
  // 2.5 SOL @ $200 = $500 · 0.075 ETH @ $4000 = $300 · 0.3333333 BNB @ $600 = $200
  stubRpc({ [hostOf('ethereum')]: 0.075, [hostOf('bsc')]: 1 / 3, [hostOf('base')]: 0, [hostOf('arbitrum')]: 0 });
  const evm = await valueEvmAddress('0x' + '1'.repeat(40), PRICES);
  const sol = await valueSolanaAddress({ getBalance: async () => 2.5 * 1e9 }, 'fake', PRICES);
  const all = [...sol.holdings, ...evm.holdings];
  assert.equal(all.length, 3, 'SOL, ETH and BNB should each be counted');
  assert.equal(Math.round(totalUsd(all)), 1000);
  assert.ok(qualifies(totalUsd(all)), 'should reach the $1,000 threshold');
});

test('sub-cent dust at the line does not lock someone out', () => {
  // A sum that lands a hair under $1,000 through floating-point error still gets in.
  assert.ok(qualifies(999.9999998));
  // A genuinely short wallet still does not.
  assert.equal(qualifies(999.5), false);
});

test('a wallet just under the threshold does not qualify', async () => {
  stubRpc({ [hostOf('ethereum')]: 0.2, [hostOf('bsc')]: 0, [hostOf('base')]: 0, [hostOf('arbitrum')]: 0 });
  const { holdings } = await valueEvmAddress('0x' + '1'.repeat(40), PRICES);
  assert.equal(totalUsd(holdings), 800);
  assert.ok(totalUsd(holdings) < 1000);
});

test('one dead chain is tolerated and reported, the rest still count', async () => {
  stubRpc({ [hostOf('ethereum')]: 0.25, [hostOf('bsc')]: 'fail', [hostOf('base')]: 0, [hostOf('arbitrum')]: 0 });
  const { holdings, failed } = await valueEvmAddress('0x' + '1'.repeat(40), PRICES);
  assert.deepEqual(failed, ['BNB Chain']);
  assert.equal(totalUsd(holdings), 1000);
});

test('every chain being down throws rather than reporting a zero balance', async () => {
  stubRpc(Object.fromEntries(EVM_CHAINS.map((c) => [new URL(c.rpc).host, 'fail'])));
  await assert.rejects(() => valueEvmAddress('0x' + '1'.repeat(40), PRICES), /unreachable/);
});

test('an RPC error response throws instead of counting as zero', async () => {
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ error: { message: 'rate limited' } }) });
  await assert.rejects(() => valueEvmAddress('0x' + '1'.repeat(40), PRICES), /unreachable/);
});

test('large balances keep precision through the BigInt divide', async () => {
  stubRpc({ [hostOf('ethereum')]: 1234.5, [hostOf('bsc')]: 0, [hostOf('base')]: 0, [hostOf('arbitrum')]: 0 });
  const { holdings } = await valueEvmAddress('0x' + '1'.repeat(40), PRICES);
  assert.ok(Math.abs(holdings[0].amount - 1234.5) < 1e-6);
});

test('a Solana wallet with no SOL yields no holdings', async () => {
  const { holdings } = await valueSolanaAddress({ getBalance: async () => 0 }, 'fake', PRICES);
  assert.deepEqual(holdings, []);
  assert.equal(totalUsd(holdings), 0);
});

test('holdings are described biggest-first', () => {
  const desc = describeHoldings([
    { chain: 'Solana', symbol: 'SOL', amount: 1, usd: 200 },
    { chain: 'Ethereum', symbol: 'ETH', amount: 0.2, usd: 800 },
  ]);
  assert.equal(desc, '0.2 ETH on Ethereum ($800.00), 1.000 SOL on Solana ($200.00)');
});

// ── Price sources (shapes copied from real responses) ───────────────────────
const COINBASE = { data: { currency: 'USD', rates: { SOL: '0.0136', ETH: '0.000549', BNB: '0.001686' } } };
const BINANCE_US = [{ symbol: 'ETHUSD', price: '1822.63' }, { symbol: 'BNBUSD', price: '593.00' }, { symbol: 'SOLUSD', price: '73.64' }];
const KRAKEN = { error: [], result: { XETHZUSD: { c: ['1821.82', '1'] }, SOLUSD: { c: ['73.61', '1'] } } };

/** Stub fetch by host: value is a JSON body, an HTTP status number, or 'fail'. */
function stubPrices(byHost) {
  globalThis.fetch = async (url) => {
    const v = byHost[new URL(url).host];
    if (v === undefined || v === 'fail') throw new Error('connection refused');
    if (typeof v === 'number') return { ok: false, status: v, json: async () => ({}) };
    return { ok: true, json: async () => v };
  };
}
// getPrices caches for 60s; bust it between tests by re-importing a fresh module.
async function freshGetPrices() {
  const mod = await import(`../src/chains.js?t=${Date.now()}-${Math.random()}`);
  return mod.getPrices;
}

test('coinbase alone prices all three coins (rates are inverted)', async () => {
  stubPrices({ 'api.coinbase.com': COINBASE });
  const p = await (await freshGetPrices())();
  assert.ok(Math.abs(p.solana - 1 / 0.0136) < 1e-6);
  assert.ok(Math.abs(p.ethereum - 1 / 0.000549) < 1e-6);
  assert.ok(Math.abs(p.binancecoin - 1 / 0.001686) < 1e-6);
});

test('the exact Render failure (coingecko 429 + binance 451) is survived via binance.us', async () => {
  stubPrices({ 'api.coinbase.com': 'fail', 'api.binance.us': BINANCE_US, 'api.coingecko.com': 429, 'api.binance.com': 451 });
  const p = await (await freshGetPrices())();
  assert.deepEqual(p, { solana: 73.64, ethereum: 1822.63, binancecoin: 593 });
});

test('a partial source (kraken, no BNB) is merged with a later one', async () => {
  stubPrices({ 'api.coinbase.com': 'fail', 'api.binance.us': 'fail', 'api.coingecko.com': 429, 'api.kraken.com': KRAKEN, 'api.binance.com': [{ symbol: 'BNBUSDT', price: '590' }] });
  const p = await (await freshGetPrices())();
  assert.equal(p.solana, 73.61);
  assert.equal(p.ethereum, 1821.82);
  assert.equal(p.binancecoin, 590);
});

test('a bad value from one source does not poison the merge', async () => {
  stubPrices({ 'api.coinbase.com': { data: { rates: { SOL: '0', ETH: 'nope', BNB: '-1' } } }, 'api.binance.us': BINANCE_US });
  const p = await (await freshGetPrices())();
  assert.deepEqual(p, { solana: 73.64, ethereum: 1822.63, binancecoin: 593 });
});

test('the price feed fails closed when no source can price a coin', async () => {
  stubPrices({ 'api.kraken.com': KRAKEN }); // SOL + ETH only, everything else down
  await assert.rejects(() => freshGetPrices().then((f) => f()), /No price for BNB/);
});

test('the price feed fails closed when nothing is reachable', async () => {
  globalThis.fetch = async () => { throw new Error('blocked'); };
  await assert.rejects(() => freshGetPrices().then((f) => f()), /No price for SOL, ETH, BNB/);
});
