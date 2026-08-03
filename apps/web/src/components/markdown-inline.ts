/**
 * Inline Markdown tokenizing, separated from rendering so it can be tested.
 *
 * This lives apart from `MarkdownBody.tsx` for one reason: Node's type stripping does not transform
 * JSX, so nothing in a `.tsx` file can be reached by `node --test`. The ReDoS defect below was
 * introduced, "fixed" wrongly, and only caught by an external reviewer — precisely because the code
 * sat in a file the test runner could not load. Plain `.ts` makes the guarantee assertable.
 */

/**
 * Total characters one render may tokenize before it gives up and emits plain text.
 *
 * A previous attempt capped each CALL at 20k, which was wrong twice over and both errors matter:
 *
 *   1. A per-call cap is not a document bound. A 2 MiB payload split into 105 lines of 19,990 `[`
 *      stayed under the cap every time and still took 25.8 seconds — the cap turned O(N²) into
 *      O(N × 20000), a gentler slope rather than a ceiling.
 *   2. Its comment claimed this runs "in the reader's browser ... not a CLI". False:
 *      `reader/[id]/page.tsx` is an async Server Component and nothing in the chain is
 *      `'use client'`, so it runs during SSR and blocks the Node event loop for every concurrent
 *      request. Getting the threat model backwards is what made the fix look adequate.
 *
 * Per render, combined with the bounded quantifiers below, worst-case work is about BUDGET × 500
 * regardless of how the input is shaped. Real documents never approach it.
 */
export const INLINE_BUDGET = 200_000;

/**
 * Every alternative uses a BOUNDED quantifier, and that is the actual fix.
 *
 * `[^\]\n]*` is what made this quadratic: on a run of unbalanced `[`, the engine starts an attempt
 * at every one, scans to end-of-line looking for `]`, fails, and backtracks. `{0,500}` caps the work
 * per starting position at a constant rather than the remaining line length. A "link" whose text
 * exceeds 500 characters, or whose URL exceeds 2000, is simply not treated as a link — the correct
 * trade, since no real one is and the alternative is an unbounded scan over attacker text.
 */
export const INLINE_PATTERN =
  '(`[^`\\n]{1,500}`)|(\\*\\*[^*\\n]{1,500}\\*\\*)|(\\*[^*\\n]{1,500}\\*)|(_[^_\\n]{1,500}_)|(\\[[^\\]\\n]{0,500}\\]\\([^)\\n]{0,2000}\\))';

export type InlineToken =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'code'; readonly text: string }
  | { readonly kind: 'strong'; readonly text: string }
  | { readonly kind: 'em'; readonly text: string };

export interface InlineBudget {
  remaining: number;
}

export const newInlineBudget = (): InlineBudget => ({ remaining: INLINE_BUDGET });

/**
 * Splits text into inline tokens. Never returns markup — the caller decides what an `em` looks like.
 *
 * A link becomes a `text` token holding only its label. The href is discarded rather than rendered
 * inert: an ingested document's URL is attacker-controlled, and a live link is a navigation
 * primitive nobody has decided to grant.
 */
export function tokenizeInline(text: string, budget: InlineBudget): readonly InlineToken[] {
  if (text.length > budget.remaining) {
    budget.remaining = 0;
    return [{ kind: 'text', text }];
  }
  budget.remaining -= text.length;

  const out: InlineToken[] = [];
  const pattern = new RegExp(INLINE_PATTERN, 'g');

  let last = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) out.push({ kind: 'text', text: text.slice(last, match.index) });
    const token = match[0];

    if (token.startsWith('`')) {
      out.push({ kind: 'code', text: token.slice(1, -1) });
    } else if (token.startsWith('**')) {
      out.push({ kind: 'strong', text: token.slice(2, -2) });
    } else if (token.startsWith('[')) {
      out.push({ kind: 'text', text: token.slice(1, token.indexOf(']')) });
    } else {
      out.push({ kind: 'em', text: token.slice(1, -1) });
    }
    last = match.index + token.length;
  }

  if (last < text.length) out.push({ kind: 'text', text: text.slice(last) });
  return out.length ? out : [{ kind: 'text', text }];
}
