import styles from './ReaderScreen.module.css';
import { newInlineBudget, tokenizeInline, type InlineBudget } from './markdown-inline.ts';

/**
 * A small Markdown renderer for the reader.
 *
 * Renders into React text nodes, never `dangerouslySetInnerHTML`. Document bodies are untrusted
 * content (ADR 0005) — a real Markdown-to-HTML pipeline would need sanitizing, and inline HTML in an
 * ingested document must never become live markup here. That constraint is why this is hand-written
 * rather than a library: every node below is created by React, so there is no path from document
 * text to executable markup.
 *
 * Scope grew after the first real corpus went in. The original version handled headings,
 * paragraphs, and fenced code — which was enough for the handoff's mockup, whose reader shows a
 * page of prose. The actual documents are engineering notes: mostly lists and tables. Those fell
 * through to the paragraph branch and were joined with spaces, so a ten-row table rendered as one
 * long unreadable line. The handoff could not have shown that, because it had no real data in it.
 *
 * Still deliberately partial. Unsupported syntax renders as its source text, which is honest rather
 * than silently dropped.
 */

type Inline = React.ReactNode;

/**
 * Inline spans: `code`, **strong**, *emphasis*, and [links](url) reduced to their text.
 *
 * The previous version stripped `*`, `_` and backticks outright, which turned "**must not**" into
 * "must not" — losing exactly the emphasis an engineering document uses to mark the load-bearing
 * sentence. Links become plain text rather than anchors on purpose: an ingested document's URL is
 * attacker-controlled, and a live link is a navigation primitive we have not decided to grant.
 */
/**
 * Renders tokenized inline spans. Tokenizing lives in ./markdown-inline.ts so it is reachable by
 * the test runner — Node strips types but does not transform JSX, so nothing in this file can be.
 */
function inline(text: string, keyPrefix: string, budget: InlineBudget): Inline[] {
  return tokenizeInline(text, budget).map((t, i) => {
    const key = `${keyPrefix}i${i}`;
    if (t.kind === "code") {
      return (
        <code key={key} className={styles.inlineCode}>
          {t.text}
        </code>
      );
    }
    if (t.kind === "strong") return <strong key={key}>{t.text}</strong>;
    if (t.kind === "em") return <em key={key}>{t.text}</em>;
    return t.text;
  });
}

const LIST_ITEM = /^\s*[-*+]\s+(.*)$/;
const ORDERED_ITEM = /^\s*\d+[.)]\s+(.*)$/;
const TABLE_ROW = /^\s*\|(.+)\|\s*$/;
const TABLE_DIVIDER = /^\s*\|[\s:|-]+\|\s*$/;
const RULE = /^\s*(-{3,}|\*{3,}|_{3,})\s*$/;

const cells = (row: string) =>
  (TABLE_ROW.exec(row)?.[1] ?? '').split('|').map((c) => c.trim());

export function MarkdownBody({ body }: { body: string }) {
  const blocks: React.ReactNode[] = [];
  const lines = body.split('\n');
  // One budget per render, shared by every inline() call — see INLINE_BUDGET.
  const budget = newInlineBudget();

  let paragraph: string[] = [];
  let inFence = false;
  let fenceLines: string[] = [];

  const flushParagraph = (key: string) => {
    if (!paragraph.length) return;
    blocks.push(<p key={key}>{inline(paragraph.join(' '), key, budget)}</p>);
    paragraph = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    // Fenced code first: everything inside is literal, including things that look like list items.
    if (line.trimStart().startsWith('```')) {
      if (!inFence) {
        flushParagraph(`p${i}`);
        inFence = true;
        fenceLines = [];
      } else {
        blocks.push(
          <pre key={`c${i}`} className={styles.code}>
            {fenceLines.join('\n')}
          </pre>,
        );
        inFence = false;
      }
      continue;
    }
    if (inFence) {
      fenceLines.push(line);
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph(`p${i}`);
      // Level is carried as a data attribute rather than h1..h6 elements: the reader is one
      // document inside an app shell that already owns the page's heading outline, so emitting a
      // real <h1> per document body would produce two competing outlines for a screen reader.
      blocks.push(
        <div key={`h${i}`} className={styles.heading} data-level={heading[1]!.length}>
          {inline(heading[2] ?? '', `h${i}`, budget)}
        </div>,
      );
      continue;
    }

    if (RULE.test(line)) {
      flushParagraph(`p${i}`);
      blocks.push(<hr key={`r${i}`} className={styles.rule} />);
      continue;
    }

    // Tables: a header row, a divider, then body rows. Without the divider it is not a table, and
    // treating it as one would swallow ordinary prose containing a pipe.
    if (TABLE_ROW.test(line) && i + 1 < lines.length && TABLE_DIVIDER.test(lines[i + 1]!)) {
      flushParagraph(`p${i}`);
      const header = cells(line);
      const rows: string[][] = [];
      let j = i + 2;
      while (j < lines.length && TABLE_ROW.test(lines[j]!) && !TABLE_DIVIDER.test(lines[j]!)) {
        rows.push(cells(lines[j]!));
        j++;
      }
      blocks.push(
        <div key={`t${i}`} className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                {header.map((c, x) => (
                  <th key={x}>{inline(c, `t${i}h${x}`, budget)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, y) => (
                <tr key={y}>
                  {r.map((c, x) => (
                    <td key={x}>{inline(c, `t${i}r${y}c${x}`, budget)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      i = j - 1;
      continue;
    }

    // Lists. Consecutive items collect into one list so the gap between them is a list gap, not a
    // paragraph gap — which is most of what makes a document scannable.
    if (LIST_ITEM.test(line) || ORDERED_ITEM.test(line)) {
      flushParagraph(`p${i}`);
      const ordered = ORDERED_ITEM.test(line) && !LIST_ITEM.test(line);
      const items: string[] = [];
      let j = i;
      while (j < lines.length) {
        const m = ordered ? ORDERED_ITEM.exec(lines[j]!) : LIST_ITEM.exec(lines[j]!);
        if (m) {
          items.push(m[1] ?? '');
          j++;
          continue;
        }
        // A wrapped continuation line belongs to the item above it, not to a new paragraph.
        if (items.length && lines[j]!.trim() !== '' && /^\s{2,}\S/.test(lines[j]!)) {
          items[items.length - 1] += ' ' + lines[j]!.trim();
          j++;
          continue;
        }
        break;
      }

      const rendered = items.map((item, x) => <li key={x}>{inline(item, `l${i}n${x}`, budget)}</li>);
      blocks.push(
        ordered ? (
          <ol key={`o${i}`} className={styles.list}>
            {rendered}
          </ol>
        ) : (
          <ul key={`u${i}`} className={styles.list}>
            {rendered}
          </ul>
        ),
      );
      i = j - 1;
      continue;
    }

    if (line.trimStart().startsWith('>')) {
      flushParagraph(`p${i}`);
      const quoted: string[] = [];
      let j = i;
      while (j < lines.length && lines[j]!.trimStart().startsWith('>')) {
        quoted.push(lines[j]!.replace(/^\s*>\s?/, ''));
        j++;
      }
      blocks.push(
        <blockquote key={`q${i}`} className={styles.quote}>
          {inline(quoted.join(' '), `q${i}`, budget)}
        </blockquote>,
      );
      i = j - 1;
      continue;
    }

    if (line.trim() === '') {
      flushParagraph(`p${i}`);
      continue;
    }
    paragraph.push(line.trim());
  }

  flushParagraph('p-last');
  // An unterminated fence still renders, rather than swallowing the rest of the document.
  if (inFence && fenceLines.length) {
    blocks.push(
      <pre key="c-last" className={styles.code}>
        {fenceLines.join('\n')}
      </pre>,
    );
  }

  return <>{blocks}</>;
}
