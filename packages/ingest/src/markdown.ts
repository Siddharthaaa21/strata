/**
 * Local Markdown adapter. Implements ADR 0003.
 *
 * fetch (walk the port) -> RawDoc -> normalize -> PendingDoc. Stops one field short of a real `Doc`:
 * `bodyRef` belongs to storage, which assigns it on persist.
 */

import { createHash } from 'node:crypto';
import yaml from 'js-yaml';
import { normalizeIngested, type Derived, type SourceId, type Untrusted } from '@strata/core';
import { PortError, type FileSystemPort } from './fs-port.ts';

/** Fixed, per-code messages. Never a caught exception's own message — a YAML error embeds source text. */
export const MARKDOWN_ERRORS = {
  unreadable: 'The file could not be read.',
  'too-large': 'The file exceeds the maximum ingest size.',
  'invalid-encoding': 'The file is not valid UTF-8.',
  empty: 'The file has no content to index.',
  'frontmatter-invalid': 'The YAML frontmatter could not be parsed.',
  'path-invalid': 'The file path is not usable as a stable identifier.',
  'unsupported-type': 'The file extension is not an ingestible Markdown type.',
  'duplicate-identity': 'Another file in this import already claims this identifier.',
  // Raised by the persist stage, not the parser, but it lives here because this table is the one
  // place a message shown to a user is guaranteed sanitized — a driver error carries SQL and row
  // fragments, and ADR 0003 forbids those reaching `ImportEvent.error.message`.
  'persist-failed': 'The document could not be written to storage.',
} as const;

export type MarkdownErrorCode = keyof typeof MARKDOWN_ERRORS;

export class MarkdownError extends Error {
  readonly code: MarkdownErrorCode;

  constructor(code: MarkdownErrorCode) {
    super(MARKDOWN_ERRORS[code]);
    this.name = 'MarkdownError';
    this.code = code;
  }
}

export interface MarkdownOptions {
  /** `.mdx` is excluded by default: it embeds JSX and imports, a different and executable-adjacent parse. */
  readonly extensions?: readonly string[];
  readonly maxBytes?: number;
}

const DEFAULT_EXTENSIONS = ['.md', '.markdown'] as const;

/**
 * Extensions close enough to Markdown that somebody would expect them to import.
 *
 * These are the only non-matching files reported as `unsupported-type`. Everything else — source
 * code, lockfiles, images — is skipped without a word, because it was never a candidate. See the
 * scan loop for why that distinction earns its keep.
 */
const DOCUMENT_LIKE = ['.mdx', '.txt', '.rst', '.org', '.adoc', '.textile'] as const;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const NUL = String.fromCharCode(0);

/**
 * Byte canonicalization before hashing (ADR 0003).
 *
 * Strips a BOM, normalizes CRLF/CR to LF, and collapses trailing end-of-file whitespace to a single
 * newline. Without this, one teammate's Windows checkout re-imports the entire vault as "updated".
 * Deliberately applied to the *raw* bytes, not the normalizer's output: tying identity to the
 * normalizer's version would invalidate the whole corpus on every heuristic tweak.
 */
export function canonicalize(raw: string): string {
  return (
    raw
      .replace(/^\uFEFF/, '')
      .replace(/\r\n?/g, '\n')
      // `trimEnd()`, not `.replace(/\s*$/, '')`. The regex form is quadratic: `$` anchors to the end
      // of input, so the engine restarts `\s*` at every position in a trailing whitespace run and
      // backtracks to the end each time. Measured 4x per doubling \u2014 25k trailing spaces took 227ms,
      // 150k took 8.3s, and the 2 MiB file cap extrapolates to roughly 27 minutes of blocked event
      // loop for one crafted file whose content is just spaces. `trimEnd` is native and linear.
      .trimEnd() + '\n'
  );
}

export function contentHash(raw: string): string {
  return 'sha256:' + createHash('sha256').update(canonicalize(raw), 'utf8').digest('hex');
}

/**
 * The stable identifier for a Markdown file: its NFC-normalized, POSIX-separator path relative to
 * the scan root.
 *
 * A NUL is rejected rather than stripped. `docIdentityKey` joins fields on a NUL separator, so a
 * NUL inside a path is a key-forgery primitive, and path input is attacker-influenced whenever a
 * user imports a folder they did not author.
 */
export function toExternalId(relativePath: string): string {
  if (relativePath.includes(NUL)) throw new MarkdownError('path-invalid');

  // A backslash is REJECTED, not folded to '/'. Folding was the collision primitive: on POSIX a
  // file legitimately named `a\b.md` folded onto the real path `a/b.md`, and since identity is the
  // path, the two became one document. Within a run that is now a reported failure; ACROSS runs it
  // was undetectable — storage sees one externalId with a changed hash, which is indistinguishable
  // from an edit — so the second file silently overwrote the first with no event at all.
  //
  // Folding was never this function's job. `createNodeFileSystemPort` already converts `path.sep`
  // to '/', so a Windows checkout arrives POSIX-separated before it gets here. Doing it twice
  // bought nothing and cost a silent-data-loss path.
  if (relativePath.includes('\\')) throw new MarkdownError('path-invalid');

  const id = relativePath.normalize('NFC');
  if (id === '' || id.startsWith('../')) throw new MarkdownError('path-invalid');
  return id;
}

/** What the shared normalizer is allowed to read. Adapter-specific `sourceMeta` is never consulted. */
export interface RawOrigin {
  readonly declaredTitle?: string;
  readonly declaredSummary?: string;
  readonly declaredTags?: readonly string[];
  readonly declaredFolder?: string;
  readonly path: string;
  /** ISO-8601 UTC, from the filesystem. Never from a frontmatter date. */
  readonly modifiedAt: string;
  readonly createdAt: string;
}

export interface ParsedMarkdown {
  readonly origin: RawOrigin;
  readonly body: string;
}

/** Splits YAML frontmatter from the body. A malformed block is a failure, never a silent skip. */
export function parseFrontmatter(text: string): { data: Record<string, unknown>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!match) return { data: {}, body: text };

  let parsed: unknown;
  try {
    parsed = yaml.load(match[1]!);
  } catch {
    // js-yaml embeds the offending source line in its message. Discard it entirely.
    throw new MarkdownError('frontmatter-invalid');
  }
  if (parsed !== null && parsed !== undefined && typeof parsed !== 'object') {
    throw new MarkdownError('frontmatter-invalid');
  }
  return { data: (parsed ?? {}) as Record<string, unknown>, body: match[2] ?? '' };
}

const asString = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);

const asStringArray = (v: unknown): readonly string[] | undefined => {
  if (!Array.isArray(v)) return undefined;
  const out = [
    ...new Set(
      v
        .filter((x): x is string => typeof x === 'string')
        .map((s) => s.trim().slice(0, MAX_TAG))
        .filter(Boolean),
    ),
  ];
  return out.length ? out.slice(0, 32) : undefined;
};

/** Title: frontmatter -> first ATX heading -> basename with separators as spaces. */
export function deriveTitle(origin: RawOrigin, body: string): string {
  const declared = origin.declaredTitle;
  if (declared) return declared.slice(0, MAX_TITLE);

  const heading = /^#\s+(.+)$/m.exec(body)?.[1]?.trim();
  if (heading) return heading.slice(0, MAX_TITLE);

  const base = origin.path.split('/').pop() ?? origin.path;
  return (base.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').trim() || base).slice(0, MAX_TITLE);
}

/**
 * Upper bound on a stored excerpt, applied to BOTH derivation paths.
 *
 * The heuristic path always had it; the frontmatter path did not, and `description:` is
 * attacker-controlled and bounded only by the 2 MiB file cap. That made `search_docs` — whose own
 * description promises "metadata and excerpts only, never document bodies" — a channel for
 * body-sized prose, through the weaker of the two fences and multiplied by MAX_RESULTS rows. The
 * cap is what makes that promise true rather than aspirational.
 */
export const MAX_EXCERPT = 280;

/**
 * Upper bounds on the other three metadata channels.
 *
 * Capping only the excerpt was the incomplete half of this fix, and a reviewer measured the
 * consequence: `title`, `folder`, and `tags` were bounded solely by the 2 MiB file cap, so three
 * documents with a ~500 KB `title:` produced a **3.2 MB `search_docs` response** — with the excerpt
 * dutifully clipped to 280. At `MAX_RESULTS` rows the ceiling is tens of megabytes.
 *
 * Fencing does not help against volume. A payload larger than the context window is a denial of
 * service whether or not it is correctly labelled as untrusted, and `search_docs` promises
 * "metadata and excerpts only, never document bodies" — a promise about size as much as about
 * fields. Every channel that crosses the wire needs a bound, not just the one named "excerpt".
 *
 * These caps live in the adapter, which is the wrong layer and is recorded as such: a future
 * Claude/Cursor/GitHub adapter must re-apply them, because `DocStore.upsert` enforces nothing.
 */
export const MAX_TITLE = 300;
export const MAX_FOLDER = 200;
export const MAX_TAG = 64;

/**
 * Excerpt: frontmatter description/summary (`source`), else the first prose block (`heuristic`).
 * Code fences, HTML, tables, and headings are skipped; links are reduced to their text.
 */
export function deriveExcerpt(origin: RawOrigin, body: string): Derived<string> {
  const at = origin.modifiedAt;
  if (origin.declaredSummary) {
    return { value: origin.declaredSummary.slice(0, MAX_EXCERPT), provenance: 'source', derivedAt: at };
  }

  const withoutFences = body.replace(/```[\s\S]*?```/g, '');
  const block = withoutFences
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .find((p) => p && !p.startsWith('#') && !p.startsWith('<') && !p.startsWith('|') && !p.startsWith('>'));

  const text = (block ?? '')
    // Bound the input BEFORE the link regex, not after.
    //
    // `/\[([^\]]*)\]\([^)]*\)/g` is quadratic on unbalanced brackets: every `[` starts a match
    // attempt, `[^\]]*` scans to the end of the block, fails to find `]`, and backtracks. A first
    // paragraph of `'['.repeat(2_000_000)` — legal inside the 2 MiB file cap — measured 14.5s at
    // 200k and scales 4x per doubling.
    //
    // Slicing first is the fix rather than a cleverer regex, because the output is capped at
    // MAX_EXCERPT anyway: no correct excerpt can depend on text beyond this window. The window is
    // deliberately much larger than MAX_EXCERPT so that stripping markup cannot starve it.
    .slice(0, MAX_EXCERPT * 8)
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_EXCERPT);

  return { value: text, provenance: 'heuristic', derivedAt: at };
}

/**
 * Folder: frontmatter, else the file's own directory, else the scan root's basename.
 *
 * A directory is `source`, not `heuristic` — a human filed it there deliberately. That distinction
 * is what keeps a later re-sync from clobbering it.
 */
export function deriveFolder(origin: RawOrigin, rootName: string): Derived<string> {
  const at = origin.modifiedAt;
  if (origin.declaredFolder) {
    return { value: origin.declaredFolder.slice(0, MAX_FOLDER), provenance: 'source', derivedAt: at };
  }

  const dir = origin.path.split('/').slice(0, -1).join('/');
  if (dir) return { value: dir.slice(0, MAX_FOLDER), provenance: 'source', derivedAt: at };
  return { value: rootName.slice(0, MAX_FOLDER), provenance: 'heuristic', derivedAt: at };
}

/**
 * Tags: frontmatter, else empty.
 *
 * Never guessed from headings or the filename. A wrong guessed tag actively hurts retrieval, and
 * model-derived tags would pull R2 into M5. Empty is `heuristic` because the rule ran and found none.
 */
export function deriveTags(origin: RawOrigin): Derived<readonly string[]> {
  const at = origin.modifiedAt;
  return origin.declaredTags
    ? { value: origin.declaredTags, provenance: 'source', derivedAt: at }
    : { value: [], provenance: 'heuristic', derivedAt: at };
}

/** Everything a `Doc` has except `id` and `bodyRef`, plus the body for storage to take. */
export interface PendingDoc {
  readonly sourceId: SourceId;
  readonly externalId: string;
  readonly contentHash: string;
  readonly title: Untrusted<string>;
  readonly excerpt: Derived<Untrusted<string>>;
  readonly folder: Derived<Untrusted<string>>;
  readonly tags: Derived<readonly Untrusted<string>[]>;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly body: Untrusted<string>;
}

export interface ScanResult {
  readonly pending: readonly PendingDoc[];
  readonly failures: readonly { readonly externalId: string; readonly code: MarkdownErrorCode }[];
}

/**
 * Reads every Markdown file under `root` and produces `PendingDoc`s.
 *
 * A per-file failure never fails the batch: one unreadable file in a folder of two hundred must not
 * lose the other one hundred and ninety-nine.
 */
export async function scanMarkdown(
  fs: FileSystemPort,
  root: string,
  sourceId: SourceId,
  options: MarkdownOptions = {},
): Promise<ScanResult> {
  const extensions = options.extensions ?? DEFAULT_EXTENSIONS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const rootName = root.split('/').filter(Boolean).pop() ?? root;

  const pending: PendingDoc[] = [];
  const failures: { externalId: string; code: MarkdownErrorCode }[] = [];

  for (const entry of await fs.scan(root)) {
    let externalId = entry.path;
    try {
      externalId = toExternalId(entry.path);

      // Recorded, not silently dropped: a skipped symlink the user expected to see is a support
      // question, and an empty failure list would make it invisible.
      if (entry.isSymlink) throw new MarkdownError('unsupported-type');

      // Not a candidate at all -> SKIPPED SILENTLY, not recorded as a failure.
      //
      // A `.ts` file in a scanned directory is not a document that failed to import; it was never a
      // document. Reporting it as a failure was harmless while the ingest was pointed at a folder of
      // Markdown, and became absurd the moment it could be pointed at a repository root: 147 failure
      // events per run, one per source file, written to the audit trail and to the Import screen —
      // burying the handful of failures that actually mean something.
      //
      // A NEAR-MISS still reports. `.mdx` and `.txt` are things somebody reasonably expects to
      // import, so silence there would look like the file was seen and quietly dropped. The
      // distinction is "would a person be surprised this did not import?", and it is the same
      // judgement D31 makes about `node_modules` versus a symlink.
      const lower = externalId.toLowerCase();
      if (!extensions.some((ext) => lower.endsWith(ext))) {
        if (DOCUMENT_LIKE.some((ext) => lower.endsWith(ext))) {
          throw new MarkdownError('unsupported-type');
        }
        continue;
      }

      const stat = await fs.stat(root, entry.path);
      if (stat.size > maxBytes) throw new MarkdownError('too-large');

      const raw = await fs.readText(root, entry.path);

      const { data, body } = parseFrontmatter(raw);
      const origin: RawOrigin = {
        ...(asString(data['title']) === undefined ? {} : { declaredTitle: asString(data['title'])! }),
        ...(asString(data['description'] ?? data['summary']) === undefined
          ? {}
          : { declaredSummary: asString(data['description'] ?? data['summary'])! }),
        ...(asStringArray(data['tags']) === undefined ? {} : { declaredTags: asStringArray(data['tags'])! }),
        ...(asString(data['folder']) === undefined ? {} : { declaredFolder: asString(data['folder'])! }),
        path: externalId,
        // Filesystem times only. Honoring a frontmatter date would let ingested content pin its own
        // recency ranking indefinitely — R2's shape outside R2's usual framing.
        modifiedAt: stat.modifiedAt,
        createdAt: stat.createdAt,
      };

      const normalizedBody = normalizeIngested(body);
      if (normalizedBody.trim() === '' && !origin.declaredTitle) throw new MarkdownError('empty');

      const excerpt = deriveExcerpt(origin, normalizedBody);
      const folder = deriveFolder(origin, rootName);
      const tags = deriveTags(origin);

      /**
       * THE HASH IS CONTENT IDENTITY, and deliberately covers the file's bytes only.
       *
       * It must stay stable when a file MOVES, because rename detection (D20) works by matching
       * identical hashes across different paths. Folding the derived `folder` in here — tried, and
       * it broke three lifecycle tests — makes every move between folders look like a new document
       * and defeats the mechanism entirely.
       *
       * Derived-field drift is a DIFFERENT question and is answered separately: `findKnown` returns
       * the stored `folder`, and the pipeline treats a mismatch as `changed`. That covers the real
       * bug — `folder` falls back to the scan ROOT's basename for a top-level file, and the root
       * name is not in the file, so the same README ingested from a differently-named directory used
       * to report `unchanged` and keep the old folder forever (D30).
       */
      const hash = contentHash(raw);

      pending.push({
        sourceId,
        externalId,
        contentHash: hash,
        title: normalizeIngested(deriveTitle(origin, normalizedBody)),
        excerpt: { ...excerpt, value: normalizeIngested(excerpt.value) },
        folder: { ...folder, value: normalizeIngested(folder.value) },
        tags: { ...tags, value: tags.value.map((t) => normalizeIngested(t)) },
        createdAt: origin.createdAt,
        updatedAt: origin.modifiedAt,
        body: normalizedBody,
      });
    } catch (e) {
      const code: MarkdownErrorCode =
        e instanceof MarkdownError
          ? e.code
          : e instanceof PortError && e.kind === 'invalid-encoding'
            ? 'invalid-encoding'
            : 'unreadable';
      failures.push({ externalId, code });
    }
  }

  return { pending, failures };
}
