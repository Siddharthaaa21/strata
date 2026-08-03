/**
 * The reader's inline tokenizer, and specifically its resistance to a crafted document body.
 *
 * This suite exists because the same defect was introduced, "fixed" wrongly, and only caught by an
 * external reviewer — three times touching one regex. The wrong fix capped each CALL at 20k
 * characters, which a chunked payload walks straight past, and its comment asserted the code runs
 * in the browser when it actually runs during SSR, where a hang blocks every concurrent request.
 *
 * So the assertions here are about the DOCUMENT, not a call, and they are wall-clock. A timing
 * assertion is blunt, but nothing else distinguishes linear from quadratic, and the margin is
 * several orders of magnitude.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { newInlineBudget, tokenizeInline, INLINE_BUDGET } from './markdown-inline.ts';

const ms = (fn: () => void) => {
  const started = process.hrtime.bigint();
  fn();
  return Number(process.hrtime.bigint() - started) / 1e6;
};

test('a chunked payload cannot walk past the budget — the exact bypass of the per-call cap', () => {
  // 105 lines of 19,990 '[' each: ~2 MiB total, every line under the old 20k per-call cap. Measured
  // 25.8 seconds against that version. One shared budget is what makes this bounded.
  const line = '['.repeat(19_990);
  const budget = newInlineBudget();

  const elapsed = ms(() => {
    for (let i = 0; i < 105; i++) tokenizeInline(line, budget);
  });

  assert.ok(elapsed < 2000, `tokenizing a chunked 2 MiB payload took ${elapsed.toFixed(0)}ms`);
  assert.equal(budget.remaining, 0, 'the budget is exhausted rather than reset per call');
});

test('a single oversized line is bounded too', () => {
  const budget = newInlineBudget();
  const elapsed = ms(() => tokenizeInline('['.repeat(2_000_000), budget));
  assert.ok(elapsed < 2000, `one 2 MiB line took ${elapsed.toFixed(0)}ms`);
});

test('unbalanced brackets just under the budget stay fast — bounded quantifiers, not the budget', () => {
  // The budget alone is not the fix: without `{0,500}` this input is still quadratic *within* the
  // allowance. This is the case that isolates the quantifier from the budget.
  const budget = newInlineBudget();
  const elapsed = ms(() => tokenizeInline('['.repeat(INLINE_BUDGET - 1), budget));
  assert.ok(elapsed < 2000, `${INLINE_BUDGET - 1} unbalanced brackets took ${elapsed.toFixed(0)}ms`);
});

test('a trailing "](" cannot re-enable the pathological path', () => {
  // The obvious cheap guard — "skip the link alternative unless the text contains '](' " — is
  // defeated by appending one. Recorded as a test so nobody reintroduces that guard believing it
  // is sufficient.
  const budget = newInlineBudget();
  const elapsed = ms(() => tokenizeInline('['.repeat(150_000) + '](x)', budget));
  assert.ok(elapsed < 2000, `brackets plus a trailing link took ${elapsed.toFixed(0)}ms`);
});

test('ordinary inline markup still tokenizes correctly', () => {
  const budget = newInlineBudget();
  const tokens = tokenizeInline('Use `npm run verify` — it is **not** optional, see [the ADR](x.md).', budget);

  assert.deepEqual(
    tokens.map((t) => [t.kind, t.text]),
    [
      ['text', 'Use '],
      ['code', 'npm run verify'],
      ['text', ' — it is '],
      ['strong', 'not'],
      ['text', ' optional, see '],
      ['text', 'the ADR'],
      ['text', '.'],
    ],
  );
});

test('a link contributes only its label — the href never reaches a token', () => {
  const budget = newInlineBudget();
  const tokens = tokenizeInline('see [docs](javascript:alert1) and [more](https://evil.test/x) here', budget);

  assert.ok(!tokens.some((t) => t.text.includes('javascript:')), 'the scheme is dropped');
  assert.ok(!tokens.some((t) => t.text.includes('evil.test')), 'the host is dropped');
  assert.equal(tokens.map((t) => t.text).join(''), 'see docs and more here');
});

test('a URL containing a closing paren ends the link early, leaving the remainder as text', () => {
  // `[^)\n]` stops at the first `)`, so `[docs](javascript:alert(1))` yields the label plus a
  // stray `)`. Recorded rather than fixed: matching balanced parens needs either recursion or the
  // unbounded scan this file exists to avoid, and the security property still holds — no part of
  // the URL reaches a token. Only the cosmetic remainder does.
  const budget = newInlineBudget();
  const tokens = tokenizeInline('see [docs](javascript:alert(1)) here', budget);

  assert.ok(!tokens.some((t) => t.text.includes('javascript:')), 'the scheme is still dropped');
  assert.equal(tokens.map((t) => t.text).join(''), 'see docs) here');
});

test('exhausting the budget degrades to plain text rather than truncating the document', () => {
  const budget = newInlineBudget();
  tokenizeInline('x'.repeat(INLINE_BUDGET), budget);

  const after = tokenizeInline('this **would** be markup', budget);
  assert.deepEqual(after, [{ kind: 'text', text: 'this **would** be markup' }]);
  assert.equal(
    after.map((t) => t.text).join(''),
    'this **would** be markup',
    'degradation must never drop content — only stop styling it',
  );
});

test('emphasis longer than the quantifier bound is left as literal text, not dropped', () => {
  const budget = newInlineBudget();
  const long = 'a'.repeat(600);
  const tokens = tokenizeInline(`**${long}**`, budget);
  assert.equal(tokens.map((t) => t.text).join(''), `**${long}**`, 'content survives, styling does not');
});
