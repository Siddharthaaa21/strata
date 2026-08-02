import styles from './ReaderScreen.module.css';

/**
 * A deliberately minimal Markdown renderer: headings, paragraphs, and fenced code.
 *
 * Renders into React text nodes, never `dangerouslySetInnerHTML`. Document bodies are untrusted
 * content (ADR 0005) — a real Markdown-to-HTML pipeline would need sanitizing, and inline HTML in
 * an ingested document must never become live markup here.
 *
 * Only the block types the handoff's reader design actually shows are supported. Anything else
 * renders as its source text, which is honest rather than silently dropped.
 */
export function MarkdownBody({ body }: { body: string }) {
  const blocks: React.ReactNode[] = [];
  const lines = body.split('\n');

  let paragraph: string[] = [];
  let inFence = false;
  let fenceLines: string[] = [];

  const flushParagraph = (key: string) => {
    if (!paragraph.length) return;
    blocks.push(
      <p key={key}>{paragraph.join(' ').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_`]/g, '')}</p>,
    );
    paragraph = [];
  };

  lines.forEach((line, i) => {
    if (line.trimStart().startsWith('```')) {
      if (!inFence) {
        flushParagraph(`p${i}`);
        inFence = true;
        fenceLines = [];
      } else {
        blocks.push(
          <div key={`c${i}`} className={styles.code}>
            {fenceLines.join('\n')}
          </div>,
        );
        inFence = false;
      }
      return;
    }
    if (inFence) {
      fenceLines.push(line);
      return;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph(`p${i}`);
      blocks.push(
        <div key={`h${i}`} className={styles.heading}>
          {heading[2]}
        </div>,
      );
      return;
    }

    if (line.trim() === '') {
      flushParagraph(`p${i}`);
      return;
    }
    paragraph.push(line.trim());
  });

  flushParagraph('p-last');
  // An unterminated fence still renders, rather than swallowing the rest of the document.
  if (inFence && fenceLines.length) {
    blocks.push(
      <div key="c-last" className={styles.code}>
        {fenceLines.join('\n')}
      </div>,
    );
  }

  return <>{blocks}</>;
}
