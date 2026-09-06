import test from 'node:test';
import assert from 'node:assert/strict';
import { safeInternalPath, isAuthPath, redirectTarget } from './safe-path.ts';

test('an ordinary same-origin path is allowed, query and all', () => {
  for (const ok of ['/', '/import', '/reader/abc-123', '/?q=cookbook&page=2', '/a/b/c.md']) {
    assert.equal(safeInternalPath(ok), ok, `rejected ${ok}`);
  }
});

test('protocol-relative URLs are refused — the bypass a naive check misses', () => {
  // `//evil.example` starts with "/" and is a DIFFERENT SITE. A `startsWith("/")` check passes it,
  // and the auth route is exactly where that gets used.
  for (const bad of ['//evil.example', '//evil.example/path', '///evil.example']) {
    assert.equal(safeInternalPath(bad), undefined, `accepted ${bad}`);
  }
});

test('a backslash cannot smuggle a host past the slash check', () => {
  // Browsers normalise "\\" to "/", so "/\\evil.example" navigates to "//evil.example".
  assert.equal(safeInternalPath('/' + String.fromCharCode(92) + 'evil.example'), undefined);
});

test('absolute URLs are refused', () => {
  for (const bad of ['https://evil.example', 'http://evil.example', 'javascript:alert(1)', 'evil.example']) {
    assert.equal(safeInternalPath(bad), undefined, `accepted ${bad}`);
  }
});

test('control characters are refused — CR/LF in a Location header splits the response', () => {
  const CR = String.fromCharCode(13);
  const LF = String.fromCharCode(10);
  const NUL = String.fromCharCode(0);
  assert.equal(safeInternalPath('/a' + CR + LF + 'Set-Cookie: session=stolen'), undefined);
  assert.equal(safeInternalPath('/a' + LF + 'X: y'), undefined);
  assert.equal(safeInternalPath('/a' + NUL + 'b'), undefined);
  assert.equal(safeInternalPath('/a' + String.fromCharCode(127)), undefined);
});

test('empty and non-string inputs are refused without throwing', () => {
  for (const bad of ['', null, undefined]) {
    assert.equal(safeInternalPath(bad), undefined);
  }
});

test('auth paths are recognised, so a sign-in cannot redirect to itself', () => {
  assert.equal(isAuthPath('/login'), true);
  assert.equal(isAuthPath('/login?reason=stale'), true);
  assert.equal(isAuthPath('/auth/callback'), true);
  assert.equal(isAuthPath('/auth/dev-login?email=x'), true);
  assert.equal(isAuthPath('/import'), false);
  // Not a prefix match on the whole string: a document whose path merely starts with the letters.
  assert.equal(isAuthPath('/loginary'), false);
});

test('redirectTarget refuses what is not worth carrying', () => {
  // The root adds a parameter that changes nothing; the auth screens are a loop.
  assert.equal(redirectTarget('/'), undefined);
  assert.equal(redirectTarget('/login'), undefined);
  assert.equal(redirectTarget('/auth/callback'), undefined);
  assert.equal(redirectTarget('//evil.example'), undefined);
  // And keeps what is.
  assert.equal(redirectTarget('/import'), '/import');
  assert.equal(redirectTarget('/?q=x'), '/?q=x');
});
