/**
 * The cookie parser, tested as what it is: a parser for a string anyone can set.
 *
 * No provider account and no Next runtime is needed for any of this, which is the point of keeping
 * the file free of both. The chunking tests are the ones that matter — chunking is invisible until
 * a real user's token crosses ~4KB, and then it signs everyone out with no error to find.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  accessTokenFromCookies,
  authCookieName,
  parseCookieHeader,
  projectRef,
} from './session-cookie.ts';

const URL_ = 'https://abcdefghijkl.supabase.co';
const NAME = 'sb-abcdefghijkl-auth-token';

const cookies = (o: Record<string, string>) => new Map(Object.entries(o));
const encode = (session: unknown) =>
  'base64-' + Buffer.from(JSON.stringify(session)).toString('base64');

test('the cookie name is derived from the project URL, not configured twice', () => {
  assert.equal(projectRef(URL_), 'abcdefghijkl');
  assert.equal(authCookieName(URL_), NAME);
});

test('a URL with no project ref yields no cookie name rather than a wrong one', () => {
  // A name derived from a bare host would be a plausible-looking string that matches no cookie,
  // so every request would read as signed out with nothing to indicate why.
  for (const bad of ['http://localhost:3000', 'https://localhost', 'not a url', '', 'https://']) {
    assert.equal(authCookieName(bad), undefined, `${bad} produced a cookie name`);
  }
});

test('a plain JSON cookie yields the access token', () => {
  const c = cookies({ [NAME]: JSON.stringify({ access_token: 'tok-123', token_type: 'bearer' }) });
  assert.equal(accessTokenFromCookies(c, URL_), 'tok-123');
});

test('a base64- prefixed cookie yields the access token', () => {
  const c = cookies({ [NAME]: encode({ access_token: 'tok-123' }) });
  assert.equal(accessTokenFromCookies(c, URL_), 'tok-123');
});

test('the array-wrapped session shape is also accepted', () => {
  // Supabase has shipped both. Accepting one only would sign everybody out on an upgrade.
  const c = cookies({ [NAME]: encode([{ access_token: 'tok-123' }, null]) });
  assert.equal(accessTokenFromCookies(c, URL_), 'tok-123');
});

test('a CHUNKED cookie is reassembled in order', () => {
  // The case that breaks in production and nowhere else: a session only splits once it exceeds the
  // browser's ~4KB cookie limit, which happens when a provider adds claims, not when we change
  // anything.
  const whole = encode({ access_token: 'tok-' + 'x'.repeat(200) });
  const size = Math.ceil(whole.length / 3);
  const c = cookies({
    [`${NAME}.0`]: whole.slice(0, size),
    [`${NAME}.1`]: whole.slice(size, size * 2),
    [`${NAME}.2`]: whole.slice(size * 2),
  });
  assert.equal(accessTokenFromCookies(c, URL_), 'tok-' + 'x'.repeat(200));
});

test('a gap in the chunk sequence is not spliced over', () => {
  // .0 and .2 with no .1 must not be concatenated into something that parses. Stopping at the gap
  // means a partial cookie reads as no session, which is the safe direction.
  const whole = encode({ access_token: 'tok-123' });
  const half = Math.ceil(whole.length / 2);
  const c = cookies({ [`${NAME}.0`]: whole.slice(0, half), [`${NAME}.2`]: whole.slice(half) });
  assert.equal(accessTokenFromCookies(c, URL_), undefined);
});

test('an oversized cookie is refused rather than parsed', () => {
  // Cookies are attacker-controlled and chunks are concatenated, so an unbounded reader offers a
  // free way to make the server JSON.parse megabytes on every request.
  const c = cookies(
    Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`${NAME}.${i}`, 'A'.repeat(20_000)])),
  );
  assert.equal(accessTokenFromCookies(c, URL_), undefined);
});

test('every malformed shape is undefined, never a throw', () => {
  // This runs on every request including unauthenticated ones. A parser that throws on bad input
  // hands anyone a 500 for the price of a malformed cookie.
  for (const value of [
    '',
    'not json',
    'base64-!!!not-base64!!!',
    'base64-' + Buffer.from('not json').toString('base64'),
    JSON.stringify(null),
    JSON.stringify('a string'),
    JSON.stringify(42),
    JSON.stringify([]),
    JSON.stringify({}),
    JSON.stringify({ access_token: '' }),
    JSON.stringify({ access_token: 42 }),
    JSON.stringify({ access_token: null }),
  ]) {
    assert.doesNotThrow(() => accessTokenFromCookies(cookies({ [NAME]: value }), URL_));
    assert.equal(
      accessTokenFromCookies(cookies({ [NAME]: value }), URL_),
      undefined,
      `${value.slice(0, 40)} produced a token`,
    );
  }
  assert.equal(accessTokenFromCookies(cookies({}), URL_), undefined, 'no cookie is not an error');
});

test('a cookie for a different project is ignored', () => {
  // Deriving the name from the configured URL is what makes this true. A reader that took any
  // sb-*-auth-token would accept a session minted by a project we do not control.
  const c = cookies({ 'sb-someoneelse-auth-token': encode({ access_token: 'tok-attacker' }) });
  assert.equal(accessTokenFromCookies(c, URL_), undefined);
});

test('parseCookieHeader handles the ordinary cases and keeps the FIRST duplicate', () => {
  const m = parseCookieHeader('a=1; b=two;  c=%20spaced%20 ; empty=');
  assert.equal(m.get('a'), '1');
  assert.equal(m.get('b'), 'two');
  assert.equal(m.get('c'), ' spaced ');
  assert.equal(m.get('empty'), '');

  // A duplicated name is how a neighbouring subdomain or a stale path shadows the real cookie.
  // Taking the last would let whoever can set one override the session the login flow wrote.
  assert.equal(parseCookieHeader('s=real; s=injected').get('s'), 'real');
  assert.equal(parseCookieHeader(null).size, 0);
  assert.equal(parseCookieHeader('nonsense').size, 0);
});
