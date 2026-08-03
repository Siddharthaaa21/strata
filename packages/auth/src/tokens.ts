/**
 * Agent token format, minting, and verification primitives (ADR 0006 section 3).
 *
 * Pure functions over strings and bytes — no storage, no clock, no environment. That is what lets
 * the format be tested exhaustively without a database, and what keeps `createAuthenticator` free to
 * be the only thing that knows about revocation.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Fixed, greppable prefix.
 *
 * Deliberately distinctive so a secret scanner, a pre-commit hook, or a human skimming a diff can
 * spot one pasted into the repo. A token that looks like an opaque blob is one nobody notices.
 */
export const TOKEN_PREFIX = 'stra_at_';

/** 8 bytes hex. Public, stored in cleartext, and the primary key verification looks up. */
const TOKEN_ID_BYTES = 8;

/**
 * 32 bytes base64url. 256 bits of CSPRNG output, never stored, shown once.
 *
 * The size is why this is SHA-256 rather than bcrypt or argon2 (ADR 0006 §3): a slow KDF exists to
 * make an offline dictionary attack expensive against a low-entropy human-chosen secret. There is no
 * dictionary for 256 random bits, so a 100ms KDF on every MCP call would buy latency and nothing
 * else. Recorded here because "why isn't this bcrypt" is the reflexive review comment, and it is
 * wrong for this input.
 */
const SECRET_BYTES = 32;

export interface MintedToken {
  /** Public handle. Store this. */
  readonly tokenId: string;
  /** The full token. Return to the user ONCE; it cannot be recovered. */
  readonly presented: string;
  /** Store this. Never the secret. */
  readonly tokenHash: Buffer;
  /** Last 4 characters of the secret, so a UI can say *which* token without revealing one. */
  readonly last4: string;
}

const base64url = (b: Buffer) => b.toString('base64url');

export function hashSecret(secret: string): Buffer {
  return createHash('sha256').update(secret, 'utf8').digest();
}

/** Mints a new agent token. The secret exists only in the return value. */
export function mintAgentToken(): MintedToken {
  const tokenId = randomBytes(TOKEN_ID_BYTES).toString('hex');
  const secret = base64url(randomBytes(SECRET_BYTES));
  return {
    tokenId,
    presented: `${TOKEN_PREFIX}${tokenId}_${secret}`,
    tokenHash: hashSecret(secret),
    last4: secret.slice(-4),
  };
}

export interface ParsedToken {
  readonly tokenId: string;
  readonly secret: string;
}

/**
 * Splits a presented token. Returns undefined on any malformed input rather than throwing, so the
 * caller reports one indistinguishable failure for "wrong shape" and "no such token".
 *
 * Splits on the FIRST underscore after the prefix, not the last and not all of them: base64url
 * excludes `+` and `/` but the alphabet is `A-Za-z0-9-_`, so a secret can legitimately contain
 * underscores. `split('_')` would corrupt those.
 */
export function parseAgentToken(presented: string): ParsedToken | undefined {
  if (!presented.startsWith(TOKEN_PREFIX)) return undefined;
  const rest = presented.slice(TOKEN_PREFIX.length);
  const sep = rest.indexOf('_');
  if (sep <= 0) return undefined;

  const tokenId = rest.slice(0, sep);
  const secret = rest.slice(sep + 1);
  if (!/^[0-9a-f]{16}$/.test(tokenId) || secret.length === 0) return undefined;
  return { tokenId, secret };
}

/**
 * Constant-time comparison of a presented secret against a stored hash.
 *
 * `timingSafeEqual` throws on a length mismatch, which would itself be a timing signal and a crash;
 * both operands are SHA-256 digests here, so lengths always agree — the guard is for a corrupt
 * stored value, not for untrusted input.
 */
export function secretMatches(secret: string, storedHash: Uint8Array): boolean {
  const presented = hashSecret(secret);
  if (presented.length !== storedHash.length) return false;
  return timingSafeEqual(presented, Buffer.from(storedHash));
}
