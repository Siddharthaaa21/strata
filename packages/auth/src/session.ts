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
  /**
   * Accept a token whose email the provider has NOT asserted as verified.
   *
   * Off by default, and named to read badly in a config file, because that is what it is. The
   * allowlist matches on email address; if a provider will hand out a session for an address
   * nobody proved they own, then "invite alice@company.com" becomes "invite whoever claims to be
   * alice@company.com". Turning this on is only defensible for a provider that verifies out of
   * band and does not say so in the token.
   */
  readonly allowUnverifiedEmail?: boolean;
}

export class SessionError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`session token rejected: ${reason}`);
    this.name = 'SessionError';
    this.reason = reason;
  }
}

/**
 * Decodes one JWS segment to an OBJECT, or throws `SessionError`.
 *
 * The object check is not pedantry. `JSON.parse` happily returns `null`, a number, or an array,
 * and every one of those is reachable from an attacker-supplied token: `eyJ9` style segments
 * decoding to `null` made `header.alg` a property read on `null`, which throws `TypeError`, not
 * `SessionError`. That difference matters because the caller maps `SessionError` to one wire word
 * and lets anything else escape — so a malformed token surfaced as a 500 with a stack trace
 * instead of a clean rejection. The distinction between "we rejected you" and "you crashed us" is
 * one an attacker reads for free.
 *
 * A null prototype so that later key lookups on the decoded object cannot walk `Object.prototype`.
 */
const decodeObject = (part: string): Record<string, unknown> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  } catch {
    throw new SessionError('malformed');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SessionError('malformed');
  }
  return Object.assign(Object.create(null) as Record<string, unknown>, parsed);
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

/**
 * True only when the provider explicitly asserts the address is verified.
 *
 * Two locations, because providers disagree: the OIDC standard puts `email_verified` at the top
 * level, and Supabase puts it inside `user_metadata`. Anything other than boolean `true` in one of
 * those two places is not an assertion — absent, `"true"`, `1`, and `null` all read as "no".
 */
function claimsEmailVerified(payload: Record<string, unknown>): boolean {
  if (payload['email_verified'] === true) return true;

  const meta = payload['user_metadata'];
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) return false;
  return Object.hasOwn(meta, 'email_verified') && (meta as Record<string, unknown>)['email_verified'] === true;
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

  // `Object.hasOwn`, not a truthiness check on the value.
  //
  // `kid` is attacker-controlled, and plain property access inherits from `Object.prototype`: a
  // header of `{"kid":"constructor"}` returned `Object`, which is not `undefined`, so it walked
  // straight past the unknown-kid guard and into `createPublicKey` — where it threw `TypeError`
  // rather than `SessionError` and escaped as a 500. `__proto__`, `toString`, and `valueOf` all
  // behave the same way. An own-property check is the fix for the whole class at once.
  const keys = config.publicKeys!;
  if (!Object.hasOwn(keys, kid)) throw new SessionError('unknown kid');
  const jwk = keys[kid];
  if (jwk === null || typeof jwk !== 'object') throw new SessionError('unknown kid');

  // A JWKS is fetched from the provider, so a malformed entry is not purely our own configuration
  // error — and `createPublicKey` reports one by throwing something that is not a `SessionError`.
  let key;
  try {
    key = createPublicKey({ key: jwk, format: 'jwk' });
  } catch {
    throw new SessionError('unusable key');
  }
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

  const header = decodeObject(parts[0]!);
  const signature = Buffer.from(parts[2]!, 'base64url');

  const alg = header['alg'];
  if (alg !== 'HS256' && alg !== 'RS256' && alg !== 'ES256') {
    // Catches `none` and every other unsupported value in one place. `none` is not special-cased
    // because an allowlist that happens to exclude it is stronger than a denylist that names it.
    throw new SessionError(`algorithm ${String(alg)}`);
  }

  verifySignature(
    config,
    alg,
    typeof header['kid'] === 'string' ? header['kid'] : undefined,
    `${parts[0]}.${parts[1]}`,
    signature,
  );

  // Signature first, claims second — including the DECODE, which used to happen above alongside the
  // header. Only the header has to be read early, because `alg` and `kid` select the verification
  // path; the payload does not, so parsing it first bought nothing and meant a malformed payload
  // was reported as malformed on a token whose signature had never been checked. Decoding here
  // makes the ordering in the code match the sentence describing it.
  const payload = decodeObject(parts[1]!);

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

  // A provider can assert an address it never checked, and the allowlist matches on address. If a
  // deployment permits unverified sign-up, an attacker registers a colleague's address and the
  // allowlist lets them in as that colleague.
  //
  // This check REQUIRES an explicit true. The previous form rejected only an explicit `false`,
  // which meant an absent claim read as verified — and absent is the normal case, not the exotic
  // one: Supabase carries the flag inside `user_metadata`, so a top-level lookup found nothing on
  // the very provider this was written for and the check never fired at all. A guard that is
  // satisfied by silence protects nothing.
  //
  // Both locations are consulted because providers disagree on where it lives, and `hasOwn` guards
  // the nested read for the same reason `kid` does above — `user_metadata` is parsed from the
  // token and reaching `constructor` there must not look like an assertion.
  if (config.allowUnverifiedEmail !== true && !claimsEmailVerified(payload)) {
    throw new SessionError('email not verified');
  }

  return { provider: config.issuer, subject, email: email.trim().toLowerCase() };
}
