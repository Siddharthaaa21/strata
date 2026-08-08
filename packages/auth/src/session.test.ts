/**
 * Session token verification, tested against synthetic keys.
 *
 * No provider account is needed to prove any of this, which is the point: the properties below are
 * facts about JWS verification, not about Supabase. Waiting for credentials to test the front door
 * would mean testing it under deadline pressure on the day it ships.
 *
 * The algorithm-confusion tests are the ones that matter most. They are the difference between a
 * verifier and a parser.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, createSign, generateKeyPairSync, type JsonWebKey } from 'node:crypto';
import { verifySessionToken, SessionError, type SessionVerifierConfig } from './session.ts';

const ISSUER = 'https://project.supabase.co/auth/v1';
const SECRET = 'a-shared-secret-of-adequate-length-for-hs256';
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const rsaJwk = rsa.publicKey.export({ format: 'jwk' }) as JsonWebKey;
const ecJwk = ec.publicKey.export({ format: 'jwk' }) as JsonWebKey;

const future = Math.floor(Date.now() / 1000) + 3600;

/**
 * A token as a correctly-configured provider would issue it.
 *
 * `email_verified` is part of the DEFAULT, not something individual tests opt into. It was absent
 * before, which meant every happy-path test above was quietly asserting that an unverified address
 * is accepted — the fixture encoded the bug, so the bug could not fail a test.
 */
function claims(over: Record<string, unknown> = {}) {
  return {
    iss: ISSUER,
    aud: 'authenticated',
    sub: 'provider-subject-123',
    email: 'Priya@Example.COM',
    email_verified: true,
    exp: future,
    ...over,
  };
}

/** Strips a claim, for the cases where absence is the thing under test. */
function without(key: string, over: Record<string, unknown> = {}) {
  const c = claims(over) as Record<string, unknown>;
  delete c[key];
  return c;
}

/** Signs a token the way a provider would. Not a helper under test — a stand-in for the provider. */
function sign(
  alg: 'HS256' | 'RS256' | 'ES256' | 'none',
  payload: Record<string, unknown>,
  opts: { kid?: string; secret?: string } = {},
): string {
  const header = alg === 'none' ? { alg } : { alg, ...(opts.kid ? { kid: opts.kid } : {}) };
  const input = `${b64(header)}.${b64(payload)}`;

  if (alg === 'none') return `${input}.`;
  if (alg === 'HS256') {
    return `${input}.${createHmac('sha256', opts.secret ?? SECRET).update(input).digest('base64url')}`;
  }
  const signer = createSign('sha256').update(input);
  const signature =
    alg === 'ES256'
      ? signer.sign({ key: ec.privateKey, dsaEncoding: 'ieee-p1363' })
      : signer.sign(rsa.privateKey);
  return `${input}.${signature.toString('base64url')}`;
}

const hmacConfig: SessionVerifierConfig = { issuer: ISSUER, audience: 'authenticated', hmacSecret: SECRET };
const rsaConfig: SessionVerifierConfig = {
  issuer: ISSUER,
  audience: 'authenticated',
  publicKeys: { 'key-1': rsaJwk },
};
const ecConfig: SessionVerifierConfig = {
  issuer: ISSUER,
  audience: 'authenticated',
  publicKeys: { 'key-1': ecJwk },
};

const reason = (fn: () => unknown) => {
  try {
    fn();
    return null;
  } catch (e) {
    return (e as SessionError).reason;
  }
};

// --- the happy paths, one per algorithm --------------------------------------------------------

test('a valid HS256 token yields exactly the three claims we consume', () => {
  const out = verifySessionToken(sign('HS256', claims()), hmacConfig);
  assert.deepEqual(out, {
    provider: ISSUER,
    subject: 'provider-subject-123',
    // Normalized here so the allowlist cannot miss on capitalisation.
    email: 'priya@example.com',
  });
});

test('a valid RS256 token verifies against its JWKS entry', () => {
  const out = verifySessionToken(sign('RS256', claims(), { kid: 'key-1' }), rsaConfig);
  assert.equal(out.subject, 'provider-subject-123');
});

test('a valid ES256 token verifies — raw r||s, not DER', () => {
  // JWS ECDSA signatures are IEEE P1363, and Node defaults to DER. Without the explicit
  // dsaEncoding every valid ES256 token fails in a way that looks like a key problem.
  const out = verifySessionToken(sign('ES256', claims(), { kid: 'key-1' }), ecConfig);
  assert.equal(out.subject, 'provider-subject-123');
});

// --- the attacks this file exists for ----------------------------------------------------------

test('alg: none is rejected', () => {
  assert.equal(reason(() => verifySessionToken(sign('none', claims()), hmacConfig)), 'algorithm none');
});

test('algorithm confusion: an HS256 token signed with the PUBLIC KEY is rejected', () => {
  // The classic attack. The RSA public key is not secret, so an attacker can HMAC with it; a
  // verifier that lets the token's header choose the algorithm then validates the signature.
  // Configuration decides the key kind here, so the header cannot select it.
  const publicKeyPem = rsa.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const forged = sign('HS256', claims(), { secret: publicKeyPem });

  assert.equal(
    reason(() => verifySessionToken(forged, rsaConfig)),
    'HS256 against a public key — algorithm confusion',
  );
});

test('an asymmetric token is rejected by a shared-secret verifier', () => {
  // The mirror image: configuration says HMAC, so a well-formed RS256 token is refused rather than
  // being verified by a path that was not configured.
  assert.equal(
    reason(() => verifySessionToken(sign('RS256', claims(), { kid: 'key-1' }), hmacConfig)),
    'algorithm RS256 against a shared secret',
  );
});

test('configuring both key kinds is refused outright', () => {
  const both = { ...hmacConfig, publicKeys: { 'key-1': rsaJwk } };
  assert.equal(
    reason(() => verifySessionToken(sign('HS256', claims()), both)),
    'config: both hmacSecret and publicKeys',
  );
});

test('a tampered payload fails the signature, not a claim check', () => {
  // Proves the ordering: signature before claims. If claims were read first, a tampered token would
  // fail on whatever claim was edited, and "verified" would quietly mean "parsed".
  const token = sign('HS256', claims());
  const [h, , s] = token.split('.');
  const tampered = `${h}.${b64(claims({ sub: 'somebody-else' }))}.${s}`;
  assert.equal(reason(() => verifySessionToken(tampered, hmacConfig)), 'signature');
});

test('an unknown kid is refused rather than tried against every key', () => {
  assert.equal(
    reason(() => verifySessionToken(sign('RS256', claims(), { kid: 'rotated-away' }), rsaConfig)),
    'unknown kid',
  );
});

// --- claim validation --------------------------------------------------------------------------

test('an expired token is rejected, with tolerance for clock skew', () => {
  const past = Math.floor(Date.now() / 1000) - 3600;
  assert.equal(reason(() => verifySessionToken(sign('HS256', claims({ exp: past })), hmacConfig)), 'expired');

  // Just inside the tolerance window still passes — provider and app clocks are never identical.
  const barely = Math.floor(Date.now() / 1000) - 30;
  assert.ok(verifySessionToken(sign('HS256', claims({ exp: barely })), hmacConfig));
});

test('a token with no exp is rejected — an unexpiring session is not a session', () => {
  const noExp = claims();
  delete (noExp as Record<string, unknown>)['exp'];
  assert.equal(reason(() => verifySessionToken(sign('HS256', noExp), hmacConfig)), 'no exp');
});

test('issuer and audience must both match', () => {
  assert.equal(
    reason(() => verifySessionToken(sign('HS256', claims({ iss: 'https://evil.test' })), hmacConfig)),
    'issuer',
  );
  assert.equal(
    reason(() => verifySessionToken(sign('HS256', claims({ aud: 'anon' })), hmacConfig)),
    'audience',
  );
  // An array `aud` containing ours is fine — the spec allows it and providers use it.
  assert.ok(verifySessionToken(sign('HS256', claims({ aud: ['authenticated', 'other'] })), hmacConfig));
});

test('email verification must be ASSERTED, not merely un-denied', () => {
  // A provider can assert an address it never checked. If a deployment allows unverified sign-up,
  // an attacker registers a colleague's address and the allowlist matches it as that colleague.
  //
  // The previous version of this test checked `false` and `true` and stopped there, so it passed
  // while ABSENT — the case that actually occurs — sailed through. Absent is the whole point:
  // Supabase does not put this claim at the top level, so on the very provider this was written
  // for, the guard never ran once.
  for (const payload of [
    without('email_verified'),
    claims({ email_verified: false }),
    claims({ email_verified: 'true' }), // a string is not an assertion
    claims({ email_verified: 1 }),
    claims({ email_verified: null }),
    without('email_verified', { user_metadata: { email_verified: false } }),
    without('email_verified', { user_metadata: {} }),
    without('email_verified', { user_metadata: null }),
  ]) {
    const p = payload as Record<string, unknown>;
    assert.equal(
      reason(() => verifySessionToken(sign('HS256', payload), hmacConfig)),
      'email not verified',
      `accepted: email_verified=${JSON.stringify(p['email_verified'])} ` +
        `user_metadata=${JSON.stringify(p['user_metadata'])}`,
    );
  }

  // Accepted: an explicit true, at the top level or where Supabase actually puts it.
  assert.ok(verifySessionToken(sign('HS256', claims({ email_verified: true })), hmacConfig));
  assert.ok(
    verifySessionToken(
      sign('HS256', without('email_verified', { user_metadata: { email_verified: true } })),
      hmacConfig,
    ),
  );
});

test('the unverified-email escape hatch works, and only when asked for by name', () => {
  // It exists because a provider that verifies out of band may not say so in the token. It is off
  // by default, and turning it on is a deliberate line in a config file rather than a default
  // nobody chose.
  const token = sign('HS256', without('email_verified'));
  assert.equal(reason(() => verifySessionToken(token, hmacConfig)), 'email not verified');
  assert.ok(verifySessionToken(token, { ...hmacConfig, allowUnverifiedEmail: true }));

  // Not truthiness — the flag is checked against `true` exactly, so a stray string in a config
  // file cannot switch off the front door's verification.
  assert.equal(
    reason(() => verifySessionToken(token, { ...hmacConfig, allowUnverifiedEmail: 'yes' as never })),
    'email not verified',
  );
});

test('a kid naming an Object.prototype member is an unknown kid, not a crash', () => {
  // `config.publicKeys[kid]` is a plain property read on an attacker-controlled string. Every one
  // of these returns something non-undefined from the prototype chain, so a truthiness guard let
  // them past and `createPublicKey` threw TypeError — which is not a SessionError, so it escaped
  // the caller's mapping and surfaced as a 500 rather than a rejection.
  for (const kid of ['constructor', '__proto__', 'toString', 'valueOf', 'hasOwnProperty']) {
    assert.equal(
      reason(() => verifySessionToken(sign('RS256', claims(), { kid }), rsaConfig)),
      'unknown kid',
      `kid "${kid}" was not treated as unknown`,
    );
  }
});

test('a header or payload that is not an object is malformed, not a crash', () => {
  // JSON.parse returns null, numbers, strings and arrays quite happily, and each one made the
  // subsequent property read throw TypeError instead of SessionError.
  const sig = 'x';
  for (const part of ['null', '42', '"a string"', '[1,2,3]', 'true']) {
    const enc = Buffer.from(part).toString('base64url');
    const good = b64(claims());
    assert.equal(reason(() => verifySessionToken(`${enc}.${good}.${sig}`, hmacConfig)), 'malformed');
    assert.equal(
      reason(() => verifySessionToken(`${b64({ alg: 'HS256' })}.${enc}.${sig}`, hmacConfig)),
      // The payload is only decoded after the signature is checked, so a bad payload on a token
      // that was never signed correctly fails on the signature first. Either is a clean rejection.
      'signature',
    );
  }
});

test('missing sub or email is rejected', () => {
  const noSub = claims();
  delete (noSub as Record<string, unknown>)['sub'];
  const noEmail = claims();
  delete (noEmail as Record<string, unknown>)['email'];
  assert.equal(reason(() => verifySessionToken(sign('HS256', noSub), hmacConfig)), 'no sub');
  assert.equal(reason(() => verifySessionToken(sign('HS256', noEmail), hmacConfig)), 'no email');
});

test('malformed input never throws anything but SessionError', () => {
  for (const bad of ['', 'not-a-jwt', 'a.b', 'a.b.c.d', 'x.y.z', null, undefined, 42, {}]) {
    const r = reason(() => verifySessionToken(bad, hmacConfig));
    assert.ok(r === 'malformed' || r === 'signature', `${JSON.stringify(bad)} gave ${r}`);
  }
});
