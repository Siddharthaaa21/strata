/**
 * Verifying an identity provider's session token (ADR 0006 §5).
 *
 * Hand-written rather than taken from a library, for one reason: this is the only place a stranger's
 * bytes become a claim about who someone is, and it is 150 lines. A dependency here is a supply
 * chain attached to the front door. Everything below uses `node:crypto` and nothing else.
 *
 * PROVIDER-AGNOSTIC BY CONSTRUCTION. Supabase is the chosen provider, but nothing in this file names
 * it — it verifies a JWS and returns three claims. Swapping providers changes the configuration
 * passed in, not this code, which is the property ADR 0006 §5 exists to protect.
 *
 * This does NOT decide whether the person may use the workspace. It answers "is this token really
 * from the provider, and whose is it". Membership answers the rest, and keeping the two apart is
 * what stops a provider's user list from silently becoming our access-control list.
 */

import { createHmac, createPublicKey, timingSafeEqual, verify as cryptoVerify } from 'node:crypto';
import type { SessionClaims } from './store.ts';

/** Algorithms we will verify. `none` is absent deliberately and permanently. */
export type SessionAlgorithm = 'HS256' | 'RS256' | 'ES256';

export interface SessionVerifierConfig {
  /** Exactly the `iss` the provider stamps, e.g. `https://<ref>.supabase.co/auth/v1`. */
  readonly issuer: string;
  /** Supabase uses `authenticated`. Omit only if the provider does not set `aud`. */
  readonly audience?: string;
  /**
   * Legacy shared-secret verification. Mutually exclusive with `publicKeys` — see
   * `assertOneKeyKind` for why that exclusivity is enforced rather than merely documented.
   */
  readonly hmacSecret?: string;
  /** Asymmetric verification. JWKS entries, keyed by `kid`. */
  readonly publicKeys?: Readonly<Record<string, import('node:crypto').JsonWebKey>>;
  /** Tolerance for clock skew between us and the provider. */
  readonly clockToleranceSeconds?: number;
}

export class SessionError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`session token rejected: ${reason}`);
    this.name = 'SessionError';
    this.reason = reason;
  }
}

const decode = (part: string): unknown => {
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  } catch {
    throw new SessionError('malformed');
  }
};

/**
 * A verifier is configured for symmetric OR asymmetric, never both.
 *
 * This is the guard against algorithm confusion, and it is structural rather than a check on the
 * token. The classic attack is a token whose header says `HS256` presented to a verifier holding an
 * RSA public key: if the verifier lets the HEADER pick the algorithm, it HMACs with a value the
 * attacker already knows (the public key) and the signature verifies. Deciding the key kind from
 * CONFIGURATION means the header can never select it.
 */
function assertOneKeyKind(config: SessionVerifierConfig): 'hmac' | 'asymmetric' {
  const hasHmac = typeof config.hmacSecret === 'string' && config.hmacSecret !== '';
  const hasKeys = config.publicKeys !== undefined && Object.keys(config.publicKeys).length > 0;

  if (hasHmac && hasKeys) throw new SessionError('config: both hmacSecret and publicKeys');
  if (!hasHmac && !hasKeys) throw new SessionError('config: no verification key');
  return hasHmac ? 'hmac' : 'asymmetric';
}

function verifySignature(
  config: SessionVerifierConfig,
  alg: SessionAlgorithm,
  kid: string | undefined,
  signingInput: string,
  signature: Buffer,
): void {
  const kind = assertOneKeyKind(config);

  if (kind === 'hmac') {
    // The header may not promote a token to asymmetric verification, and it may not demote one
    // either. Configuration decides; the header only has to agree.
    if (alg !== 'HS256') throw new SessionError(`algorithm ${alg} against a shared secret`);
    const expected = createHmac('sha256', config.hmacSecret!).update(signingInput).digest();
    if (expected.length !== signature.length || !timingSafeEqual(expected, signature)) {
      throw new SessionError('signature');
    }
    return;
  }

  if (alg === 'HS256') throw new SessionError('HS256 against a public key — algorithm confusion');
  if (kid === undefined) throw new SessionError('no kid');

  const jwk = config.publicKeys![kid];
  if (jwk === undefined) throw new SessionError('unknown kid');

  const key = createPublicKey({ key: jwk, format: 'jwk' });
  const ok = cryptoVerify(
    'sha256',
    Buffer.from(signingInput),
    // JWS ECDSA signatures are raw r||s, not DER. Without this Node reads them as DER and every
    // valid ES256 token fails — a failure that looks like a key problem and is not.
    alg === 'ES256' ? { key, dsaEncoding: 'ieee-p1363' } : key,
    signature,
  );
  if (!ok) throw new SessionError('signature');
}

/**
 * Verifies a provider session token and returns exactly the three claims we consume.
 *
 * Throws `SessionError` on anything wrong. The caller maps every reason to one wire message — the
 * distinctions exist for our logs, the same discipline `AuthError` follows.
 */
export function verifySessionToken(
  token: unknown,
  config: SessionVerifierConfig,
  now: () => Date = () => new Date(),
): SessionClaims {
  if (typeof token !== 'string') throw new SessionError('malformed');

  const parts = token.split('.');
  if (parts.length !== 3) throw new SessionError('malformed');

  const header = decode(parts[0]!) as { alg?: unknown; kid?: unknown; typ?: unknown };
  const payload = decode(parts[1]!) as Record<string, unknown>;
  const signature = Buffer.from(parts[2]!, 'base64url');

  const alg = header.alg;
  if (alg !== 'HS256' && alg !== 'RS256' && alg !== 'ES256') {
    // Catches `none` and every other unsupported value in one place. `none` is not special-cased
    // because an allowlist that happens to exclude it is stronger than a denylist that names it.
    throw new SessionError(`algorithm ${String(alg)}`);
  }

  verifySignature(
    config,
    alg,
    typeof header.kid === 'string' ? header.kid : undefined,
    `${parts[0]}.${parts[1]}`,
    signature,
  );

  // Signature first, claims second. Reading claims from an unverified token and acting on them —
  // even to decide which key to use — is how "verified" quietly becomes "parsed".
  const skew = config.clockToleranceSeconds ?? 60;
  const seconds = Math.floor(now().getTime() / 1000);

  if (typeof payload['exp'] !== 'number') throw new SessionError('no exp');
  if (payload['exp'] + skew < seconds) throw new SessionError('expired');
  if (typeof payload['nbf'] === 'number' && payload['nbf'] - skew > seconds) {
    throw new SessionError('not yet valid');
  }

  if (payload['iss'] !== config.issuer) throw new SessionError('issuer');
  if (config.audience !== undefined) {
    const aud = payload['aud'];
    const matches = Array.isArray(aud) ? aud.includes(config.audience) : aud === config.audience;
    if (!matches) throw new SessionError('audience');
  }

  const subject = payload['sub'];
  const email = payload['email'];
  if (typeof subject !== 'string' || subject === '') throw new SessionError('no sub');
  if (typeof email !== 'string' || email.trim() === '') throw new SessionError('no email');

  // A provider can assert an address it never checked. Supabase sets this on the user record; if a
  // deployment allows unverified email sign-up, an attacker can claim a colleague's address and the
  // allowlist would match it. Refusing here is cheap; discovering it later is not.
  if (payload['email_verified'] === false) throw new SessionError('email not verified');

  return { provider: config.issuer, subject, email: email.trim().toLowerCase() };
}
