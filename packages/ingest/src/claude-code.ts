/**
 * The Claude Code transcript adapter — documents Claude WROTE, recovered from session logs.
 *
 * Claude Code keeps every session on disk as JSONL at `~/.claude/projects/<slug>/*.jsonl`. Those
 * transcripts record each tool call, including the full text of every file written. So a document
 * Claude produced is recoverable **even if the file was never kept** — deleted, written to a scratch
 * path, or created in a project you have since forgotten about.
 *
 * That is not hypothetical: this adapter exists because a README went missing, and the only reason
 * it was findable at all was that a transcript still held it. Doing that by hand meant grepping
 * 38 MB of JSONL. Once is a favour; twice is a feature.
 *
 * **Artifacts, not conversations.** Ingesting raw transcripts would be worse than nothing — one of
 * them is 24 MB of tool calls, diffs and reasoning, and it would bury the vault. What has a title, a
 * body and a moment it existed is the FILE, so that is the unit.
 *
 * **`Write` only, deliberately.** An `Edit` carries a replacement fragment, not the resulting file,
 * so edits cannot reconstruct content — believing otherwise would file a confidently wrong document.
 * They are COUNTED instead, and a document that was edited after its last full write says so in its
 * own body. A stale document that admits it is stale is useful; one that does not is a trap.
 */

import { createMemoryFileSystemPort, type MemoryFile } from './fs-port.ts';
import { scanMarkdown, type ScanResult } from './markdown.ts';
import type { SourceId } from '@strata/core';

/** One `Write` recovered from a transcript. */
export interface WrittenFile {
  /** Absolute path as the tool call recorded it. */
  readonly absolutePath: string;
  /** Path used as the document identity — relative to the session's cwd where possible. */
  readonly displayPath: string;
  readonly content: string;
  /** ISO-8601, from the transcript record. */
  readonly at: string;
  readonly sessionId: string;
  /** Edits to this same path recorded AFTER the write above. */
  readonly laterEdits: number;
}

export interface TranscriptFile {
  /** Directory name under `~/.claude/projects`, used only for diagnostics. */
  readonly project: string;
  readonly jsonl: string;
}

/**
 * Extensions treated as documents.
 *
 * Deliberately not "every file Claude wrote". Claude writes far more TypeScript than prose, and a
 * knowledge base full of source files is a worse knowledge base — the code already lives in the
 * repository, under version control, where it belongs. What is not recoverable elsewhere is the
 * prose: the README, the design note, the plan.
 */
export const DOCUMENT_EXTENSIONS = ['.md', '.markdown', '.mdx', '.txt', '.rst', '.adoc'] as const;

function isDocument(path: string, extensions: readonly string[]): boolean {
  const lower = path.toLowerCase();
  return extensions.some((e) => lower.endsWith(e));
}

/** `/Users/x/Desktop/proj/docs/a.md` under cwd `/Users/x/Desktop/proj` -> `proj/docs/a.md`. */
function toDisplayPath(absolutePath: string, cwd: string): string {
  const home = process.env['HOME'] ?? '';
  if (cwd !== '' && absolutePath.startsWith(cwd + '/')) {
    const projectName = cwd.split('/').filter(Boolean).pop() ?? 'project';
    return `${projectName}/${absolutePath.slice(cwd.length + 1)}`;
  }
  // Written outside the session's project — Claude Code does this for skills, settings and
  // scratch files. Kept under a distinct prefix rather than dropped: those are still documents,
  // and silently discarding them would reproduce the exact problem this adapter exists to fix.
  if (home !== '' && absolutePath.startsWith(home + '/')) {
    return `outside-project/${absolutePath.slice(home.length + 1)}`;
  }
  return `outside-project${absolutePath}`;
}

/**
 * Pulls every written document out of one transcript.
 *
 * Pure and string-in, so the interesting cases — a truncated final line, a tool call with no
 * content, the same path written three times — are all reachable from a test without a filesystem.
 *
 * **Last write wins, per path.** A file written five times in a session is ONE document with five
 * versions, and the newest is the one that was true when the session ended. Emitting five documents
 * would mean searching for a README and finding four wrong answers above the right one.
 */
export function parseTranscript(
  jsonl: string,
  options: { readonly extensions?: readonly string[] } = {},
): readonly WrittenFile[] {
  const extensions = options.extensions ?? DOCUMENT_EXTENSIONS;
  const latest = new Map<string, WrittenFile>();
  const editsAfter = new Map<string, number>();

  for (const line of jsonl.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    // A transcript being appended to right now can end mid-line. One unparsable record must not
    // lose the thousands before it.
    let record: unknown;
    try {
      record = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (record === null || typeof record !== 'object') continue;

    const r = record as Record<string, unknown>;
    const message = r['message'];
    const content = (message as Record<string, unknown> | undefined)?.['content'];
    if (!Array.isArray(content)) continue;

    const at = typeof r['timestamp'] === 'string' ? r['timestamp'] : '';
    const cwd = typeof r['cwd'] === 'string' ? r['cwd'] : '';
    const sessionId = typeof r['sessionId'] === 'string' ? r['sessionId'] : '';

    for (const block of content) {
      if (block === null || typeof block !== 'object') continue;
      const b = block as Record<string, unknown>;
      if (b['type'] !== 'tool_use') continue;

      const input = b['input'];
      if (input === null || typeof input !== 'object') continue;
      const i = input as Record<string, unknown>;
      const absolutePath = typeof i['file_path'] === 'string' ? i['file_path'] : '';
      if (absolutePath === '' || !isDocument(absolutePath, extensions)) continue;

      if (b['name'] === 'Write') {
        const text = typeof i['content'] === 'string' ? i['content'] : '';
        if (text === '') continue;
        latest.set(absolutePath, {
          absolutePath,
          displayPath: toDisplayPath(absolutePath, cwd),
          content: text,
          at: at === '' ? new Date(0).toISOString() : at,
          sessionId,
          laterEdits: 0,
        });
        // A rewrite resets the count: edits before it are already baked into this content.
        editsAfter.set(absolutePath, 0);
      } else if (b['name'] === 'Edit' || b['name'] === 'NotebookEdit') {
        if (latest.has(absolutePath)) {
          editsAfter.set(absolutePath, (editsAfter.get(absolutePath) ?? 0) + 1);
        }
      }
    }
  }

  return [...latest.values()].map((f) => ({ ...f, laterEdits: editsAfter.get(f.absolutePath) ?? 0 }));
}

export interface ClaudeCodeScanResult extends ScanResult {
  /** Distinct documents recovered, before Markdown parsing rejected any. */
  readonly recovered: number;
  /** How many carry edits their content does not reflect. */
  readonly stale: number;
}

/**
 * Turns recovered files into `PendingDoc`s through **`scanMarkdown` itself**.
 *
 * Same reasoning as the GitHub adapter (D29) and the browser upload: the content is Markdown, and
 * Markdown already has an adapter. Fencing, the NUL check, frontmatter, title/excerpt/folder/tag
 * derivation and the failure taxonomy all apply because it is literally the same code. This file
 * decides only what counts as a document and what its identity is.
 *
 * Content here is MODEL-GENERATED, which is R2's threat in its purest form — text written by a model
 * that will later be read by one. It reaches the store through the same normalisation as anything
 * else, and never bypasses it.
 */
export async function scanClaudeCode(
  transcripts: readonly TranscriptFile[],
  sourceId: SourceId,
  options: { readonly extensions?: readonly string[] } = {},
): Promise<ClaudeCodeScanResult> {
  /** Across all transcripts, newest write of each path wins — sessions overlap and interleave. */
  const byPath = new Map<string, WrittenFile>();

  for (const t of transcripts) {
    for (const file of parseTranscript(t.jsonl, options)) {
      const existing = byPath.get(file.displayPath);
      if (existing === undefined || existing.at <= file.at) byPath.set(file.displayPath, file);
    }
  }

  const files: MemoryFile[] = [...byPath.values()].map((f) => ({
    path: f.displayPath,
    // The staleness note goes in the BODY, not only in a count nobody sees. Someone reading this
    // document needs to know its content predates edits Claude made afterwards — that is the
    // difference between a useful recovered file and a confidently wrong one.
    text:
      f.laterEdits === 0
        ? f.content
        : `${f.content}\n\n---\n\n> Recovered from a Claude Code transcript. ${f.laterEdits} edit(s) were made to this file after this version was written, and are not reflected above.\n`,
    modifiedAt: f.at,
  }));

  const scanned = await scanMarkdown(createMemoryFileSystemPort(files), '/claude-code', sourceId, {
    ...(options.extensions ? { extensions: [...options.extensions] } : {}),
  });

  return {
    recovered: files.length,
    stale: [...byPath.values()].filter((f) => f.laterEdits > 0).length,
    pending: scanned.pending,
    failures: scanned.failures,
  };
}
