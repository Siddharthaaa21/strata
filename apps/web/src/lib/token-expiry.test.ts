import { test } from 'node:test';
import assert from 'node:assert/strict';
import { secondsUntilExpiry, needsRefresh } from './token-expiry.ts';

const NOW = 1_800_000_000_000; // ms
const NOW_S = NOW / 1000;

function jwt(payload: unknown): string {
  const b64 = (o: unknown) =>
    Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'ES256' })}.${b64(payload)}.signature`;
}

test('reads the seconds remaining from exp', () => {
  assert.equal(secondsUntilExpiry(jwt({ exp: NOW_S + 3600 }), NOW), 3600);
});

test('goes negative for an expired token rather than clamping', () => {
  // Clamping to zero would make "expired an hour ago" and "expires now" the same value, and the
  // access log cannot distinguish a stale tab from a clock problem without the sign.
  assert.equal(secondsUntilExpiry(jwt({ exp: NOW_S - 120 }), NOW), -120);
});

test('base64url payloads decode — the alphabet the provider actually uses', () => {
  // A payload containing `~` and `?` produces `-` and `_` in base64url. Decoding it as plain
  // base64 yields mojibake, JSON.parse throws, and every token silently reports "cannot tell".
  const token = jwt({ exp: NOW_S + 60, sub: 'a~b?c~d?e~f', email: 'x+y@example.com' });
  assert.equal(secondsUntilExpiry(token, NOW), 60);
});

for (const [label, token] of [
  ['not a JWT', 'nonsense'],
  ['two segments', 'a.b'],
  ['payload is not base64', 'a.!!!!.c'],
  ['payload is not an object', jwt('a string')],
  ['payload is null', jwt(null)],
  ['no exp claim', jwt({ sub: 'abc' })],
] as const) {
  test(`undefined when the token is unreadable: ${label}`, () => {
    assert.equal(secondsUntilExpiry(token, NOW), undefined);
  });
}

test('a STRING exp is rejected, not coerced', () => {
  // `"1800003600" - now` is not NaN in JS -- the string coerces -- but a non-numeric one is, and
  // NaN <= skew is false, which would disable refreshing entirely for that token.
  assert.equal(secondsUntilExpiry(jwt({ exp: String(NOW_S + 3600) }), NOW), undefined);
  assert.equal(secondsUntilExpiry(jwt({ exp: 'soon' }), NOW), undefined);
});

test('needsRefresh is false while the token has room', () => {
  assert.equal(needsRefresh(jwt({ exp: NOW_S + 3600 }), 300, NOW), false);
});

test('needsRefresh turns true inside the skew window, before expiry', () => {
  // The whole point: renew at 4m59s left, not after it is already dead and the person is on /login.
  assert.equal(needsRefresh(jwt({ exp: NOW_S + 299 }), 300, NOW), true);
  assert.equal(needsRefresh(jwt({ exp: NOW_S + 301 }), 300, NOW), false);
});

test('needsRefresh is true for an already-expired token', () => {
  assert.equal(needsRefresh(jwt({ exp: NOW_S - 1 }), 300, NOW), true);
});

test('an unreadable token asks for a refresh rather than being assumed fresh', () => {
  // Fails toward one wasted round trip. The opposite default fails toward a silent sign-out, which
  // is the exact bug this module exists to end.
  assert.equal(needsRefresh('nonsense', 300, NOW), true);
});
