// Restless Spirits Society — link tokens and wallet-ownership proofs.
//
// Split out of index.js so it can be unit-tested without booting Discord.
// Nothing here touches the network: it is pure signature and HMAC work.

import crypto from 'node:crypto';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { verifyMessage } from 'ethers';
import { PublicKey } from '@solana/web3.js';
import { isEvmAddress } from './chains.js';

/**
 * One-time, HMAC-signed links bound to a Discord user id.
 * Returns { makeToken, readToken }.
 */
export function createTokens(secret, ttlMs = 10 * 60 * 1000) {
  const hmac = (data) => crypto.createHmac('sha256', secret).update(data).digest('base64url');

  function makeToken(discordId) {
    const payload = { id: discordId, nonce: crypto.randomBytes(12).toString('hex'), exp: Date.now() + ttlMs };
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${body}.${hmac(body)}`;
  }

  function readToken(token) {
    if (typeof token !== 'string' || !token.includes('.')) return null;
    const [body, sig] = token.split('.');
    if (!body || !sig) return null;
    const expected = hmac(body);
    // timingSafeEqual throws on a length mismatch, so guard it first.
    if (sig.length !== expected.length) return null;
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    let payload;
    try { payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return null; }
    if (!payload?.id || !payload?.nonce || !payload?.exp) return null;
    if (Date.now() > payload.exp) return null;
    return payload;
  }

  return { makeToken, readToken };
}

/**
 * The exact text a member signs — identical for Solana and EVM wallets.
 * Always rebuilt server-side so the client can't substitute its own text.
 */
export function challengeMessage({ id, nonce }) {
  return [
    'Restless Spirits Society — wallet verification',
    '',
    `Discord ID: ${id}`,
    `Nonce: ${nonce}`,
    '',
    'Signing this only proves you own this wallet.',
    'It is a read-only signature and can never move your funds.',
  ].join('\n');
}

/** ed25519 proof. Returns the canonical base58 address, or throws a user-facing Error. */
export function checkSolanaProof(message, publicKey, signature) {
  let pubkey;
  try { pubkey = new PublicKey(publicKey); }
  catch { throw new Error('That Solana address does not look valid.'); }
  let ok = false;
  try {
    ok = nacl.sign.detached.verify(
      new TextEncoder().encode(message),
      bs58.decode(signature),
      pubkey.toBytes(),
    );
  } catch { ok = false; }
  if (!ok) throw new Error('Solana signature check failed. Make sure you signed with the wallet you connected.');
  return pubkey;
}

/** EIP-191 personal_sign proof. Returns the checksummed address, or throws a user-facing Error. */
export function checkEvmProof(message, address, signature) {
  if (!isEvmAddress(address)) throw new Error('That EVM address does not look valid.');
  let recovered;
  try { recovered = verifyMessage(message, signature); }
  catch { throw new Error('EVM signature check failed. Make sure you signed with the wallet you connected.'); }
  if (recovered.toLowerCase() !== address.toLowerCase()) {
    throw new Error('EVM signature does not match the address you connected.');
  }
  return recovered;
}

/** EVM addresses are case-insensitive; Solana addresses are not. Normalise before storing. */
export function dbKey(address) {
  return isEvmAddress(address) ? address.toLowerCase() : address;
}
