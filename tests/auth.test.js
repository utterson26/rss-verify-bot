// Ownership proofs and link tokens. No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { Wallet } from 'ethers';
import {
  createTokens, challengeMessage, checkSolanaProof, checkEvmProof, dbKey,
} from '../src/auth.js';

const SECRET = 'test-secret-do-not-use-in-production';
const { makeToken, readToken } = createTokens(SECRET);

test('a fresh token round-trips and carries the Discord id', () => {
  const payload = readToken(makeToken('123456789'));
  assert.equal(payload.id, '123456789');
  assert.match(payload.nonce, /^[0-9a-f]{24}$/);
});

test('a token signed with a different secret is rejected', () => {
  const other = createTokens('a-different-secret');
  assert.equal(readToken(other.makeToken('123456789')), null);
});

test('a tampered payload is rejected', () => {
  const token = makeToken('123456789');
  const [body, sig] = token.split('.');
  const forged = Buffer.from(JSON.stringify({ id: '999', nonce: 'x'.repeat(24), exp: Date.now() + 60000 }))
    .toString('base64url');
  assert.equal(readToken(`${forged}.${sig}`), null);
  assert.equal(readToken(`${body}.${'A'.repeat(sig.length)}`), null);
});

test('an expired token is rejected', () => {
  const past = createTokens(SECRET, -1000);
  assert.equal(readToken(past.makeToken('123456789')), null);
});

test('garbage input is rejected without throwing', () => {
  for (const bad of [null, undefined, '', 'nodot', 'a.b', 'a.', '.b', 42, {}]) {
    assert.equal(readToken(bad), null, `should reject ${JSON.stringify(bad)}`);
  }
});

// ── Solana (ed25519) ────────────────────────────────────────────────────────
test('a valid Solana signature verifies', () => {
  const kp = nacl.sign.keyPair();
  const address = bs58.encode(kp.publicKey);
  const message = challengeMessage({ id: '1', nonce: 'abc' });
  const sig = bs58.encode(nacl.sign.detached(new TextEncoder().encode(message), kp.secretKey));
  assert.equal(checkSolanaProof(message, address, sig).toBase58(), address);
});

test('a Solana signature over different text is rejected', () => {
  const kp = nacl.sign.keyPair();
  const address = bs58.encode(kp.publicKey);
  const sig = bs58.encode(nacl.sign.detached(new TextEncoder().encode('some other message'), kp.secretKey));
  assert.throws(() => checkSolanaProof(challengeMessage({ id: '1', nonce: 'abc' }), address, sig), /signature check failed/);
});

test('a Solana signature cannot be replayed under another address', () => {
  const kp = nacl.sign.keyPair();
  const other = bs58.encode(nacl.sign.keyPair().publicKey);
  const message = challengeMessage({ id: '1', nonce: 'abc' });
  const sig = bs58.encode(nacl.sign.detached(new TextEncoder().encode(message), kp.secretKey));
  assert.throws(() => checkSolanaProof(message, other, sig), /signature check failed/);
});

// ── EVM (EIP-191 personal_sign) ─────────────────────────────────────────────
test('a valid EVM signature verifies', async () => {
  const wallet = Wallet.createRandom();
  const message = challengeMessage({ id: '1', nonce: 'abc' });
  const sig = await wallet.signMessage(message);
  assert.equal(checkEvmProof(message, wallet.address, sig).toLowerCase(), wallet.address.toLowerCase());
});

test('an EVM address is matched case-insensitively', async () => {
  const wallet = Wallet.createRandom();
  const message = challengeMessage({ id: '1', nonce: 'abc' });
  const sig = await wallet.signMessage(message);
  assert.doesNotThrow(() => checkEvmProof(message, wallet.address.toLowerCase(), sig));
});

test("an EVM signature claimed for someone else's address is rejected", async () => {
  const wallet = Wallet.createRandom();
  const victim = Wallet.createRandom();
  const message = challengeMessage({ id: '1', nonce: 'abc' });
  const sig = await wallet.signMessage(message);
  assert.throws(() => checkEvmProof(message, victim.address, sig), /does not match/);
});

test('an EVM signature over different text is rejected', async () => {
  const wallet = Wallet.createRandom();
  const sig = await wallet.signMessage('gm');
  assert.throws(() => checkEvmProof(challengeMessage({ id: '1', nonce: 'abc' }), wallet.address, sig), /does not match/);
});

test('malformed EVM input is rejected with a user-facing message', async () => {
  const wallet = Wallet.createRandom();
  const message = challengeMessage({ id: '1', nonce: 'abc' });
  const sig = await wallet.signMessage(message);
  assert.throws(() => checkEvmProof(message, 'not-an-address', sig), /does not look valid/);
  assert.throws(() => checkEvmProof(message, wallet.address, '0xdeadbeef'), /signature check failed/);
});

test('the challenge text pins the Discord id and nonce', () => {
  const msg = challengeMessage({ id: '42', nonce: 'nnn' });
  assert.match(msg, /Discord ID: 42/);
  assert.match(msg, /Nonce: nnn/);
  assert.match(msg, /read-only signature/);
});

test('dbKey lowercases EVM addresses but leaves Solana ones alone', () => {
  assert.equal(dbKey('0xAbC0000000000000000000000000000000000001'), '0xabc0000000000000000000000000000000000001');
  const sol = bs58.encode(nacl.sign.keyPair().publicKey);
  assert.equal(dbKey(sol), sol);
});
