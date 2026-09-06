/**
 * Claude export adapter — an IMPORT, not a connector (D22).
 *
 * There is no Claude API to connect to. Export is Settings → Privacy → Export data: a manual act
 * producing an emailed link that expires in twenty-four hours and needs an interactive signed-in
 * browser to download. No OAuth, no pagination, no incremental sync — the four things
 * `SourceAdapter` exists to describe. So this adapter deliberately does not implement it. Bending an
 * interface to accommodate a mechanism it does not describe is how the abstraction stops meaning
 * anything; the user drops a file, we read it.
 *
 * **Identity is the conversation `uuid`,** and it is the best identity in this codebase. The
 * Markdown adapter uses a path, which moves — D20 spent a whole change repairing what that costs. A
 * conversation uuid is assigned by the source, never changes, and survives the conversation being
 * renamed, continued, or re-exported. Renaming a chat in Claude is an `updated`, automatically,
 * with no hash-matching heuristic needed.
 *
 * **R2 applies here with more force than anywhere else in the system.** This is not "documents that
 * happen to be model-generated" — it is a verbatim transcript of a model being instructed, stored
 * and served back to models over MCP. A conversation where someone asked Claude to write a prompt
 * injection is an *ordinary document* in this source. Every derived string goes through
 * `normalizeIngested`, and the body is fenced downstream like any other.
 */

import {
  normalizeIngested,
  type Derived,
  type SourceId,
  type Untrusted,
} from '@strata/core';
import {
  contentHash,
  MAX_EXCERPT,
  MAX_FOLDER,
  MAX_TITLE,
  type PendingDoc,
} from './markdown.ts';

/**
 * Why one conversation could not be imported.
 *
 * Separate from `MARKDOWN_ERRORS` because the failure modes genuinely differ — there is no
 * encoding, no path, and no file size here — but the discipline is identical: fixed per-code
 * messages, never a caught exception's own text. A `JSON.parse` error embeds the source it choked
 * on, which is the user's private conversation.
 */
export const CLAUDE_ERRORS = {
  'export-invalid': 'The Claude export could not be read as a list of conversations.',
  'conversation-invalid': 'A conversation in the export has no usable identifier.',
  empty: 'The conversation has no messages to index.',
  'too-large': 'The conversation exceeds the maximum ingest size.',
  'duplicate-identity': 'Another conversation in this import already claims this identifier.',
} as const;

export type ClaudeErrorCode = keyof typeof CLAUDE_ERRORS;

export class ClaudeExportError extends Error {
  readonly code: ClaudeErrorCode;

  constructor(code: ClaudeErrorCode) {
    super(CLAUDE_ERRORS[code]);
    this.name = 'ClaudeExportError';
    this.code = code;
  }
}

/** One conversation's worth of bytes. Generous — a long thread is legitimately large. */
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

/** No authored tags exist in a Claude export. Typed once so no call site has to cast one. */
const EMPTY_TAGS: readonly Untrusted<string>[] = [];

/** Speaker labels in the rendered transcript. The export's own vocabulary is `human`/`assistant`. */
const SPEAKER: Record<string, string> = { human: 'Human', assistant: 'Claude' };

const asString = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() !== '' ? v : undefined;

/**
 * Pulls the text out of one message.
 *
 * Two shapes are accepted because the export has carried both: a flat `text`, and a `content` array
 * of typed blocks. Unknown block types are SKIPPED rather than stringified — dumping
 * `[object Object]` or raw JSON into a body would put tool-call plumbing into a document a human
 * reads and an agent retrieves, and it would do so silently.
 *
 * Returns `undefined` for a message with nothing renderable, which the caller drops. An empty
 * assistant turn is ordinary in a transcript; it is not an error.
 */
export function messageText(message: unknown): string | undefined {
  if (message === null || typeof message !== 'object') return undefined;
  const m = message as Record<string, unknown>;

  const flat = asString(m['text']);
  if (flat !== undefined) return flat;

  const content = m['content'];
  if (!Array.isArray(content)) return undefined;

  const parts: string[] = [];
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue;
    const b = block as Record<string, unknown>;
    // Only text blocks. `tool_use` / `tool_result` are the model's plumbing, not the conversation,
    // and their payloads are exactly the kind of structured text that reads as instruction.
    if (b['type'] !== undefined && b['type'] !== 'text') continue;
    const t = asString(b['text']);
    if (t !== undefined) parts.push(t);
  }
  return parts.length === 0 ? undefined : parts.join('\n\n');
}

/**
 * One document Claude authored inside a conversation.
 *
 * `key` is stable across exports and is what makes re-import idempotent: an artifact carries its own
 * id, and a written file carries its path. Both are assigned at authoring time and survive a
 * re-export, a rename of the thread, and the conversation being continued.
 */
export interface AuthoredDoc {
  readonly key: string;
  readonly title: string;
  readonly content: string;
  /** How many earlier versions of this same document appeared before the one we kept. */
  readonly revisions: number;
  readonly createdAt: string | undefined;
}

/**
 * The documents Claude WROTE in a conversation, as opposed to the conversation itself.
 *
 * This exists because `messageText` deliberately drops `tool_use` blocks as "the model's plumbing",
 * and on claude.ai that is where authored documents actually live. An artifact is a `tool_use` block
 * named `artifacts`; a file written in the analysis sandbox is one named `create_file`. So the rule
 * that keeps tool plumbing out of a transcript was also discarding every document the user came here
 * to find — 32 of them in the export that surfaced this, including the two they asked for by name.
 *
 * Both shapes are read, and they differ:
 *   - `artifacts` carries `id`, `title`, `content` — already a document, already named.
 *   - `create_file` carries `path` and `file_text` — a file, so the name comes from the path.
 *
 * LAST WRITE WINS, and earlier ones are counted rather than emitted. A document rewritten three
 * times in one thread is one document with three revisions, not three documents; emitting each would
 * collide on identity and flip-flop between them on every re-import — the defect R2's review found in
 * the Markdown adapter, which is worth not rebuilding here.
 *
 * `str_replace` and artifact `update` commands are deliberately NOT reconstructed. Replaying an edit
 * chain to rebuild final state is a second implementation of the tool's own semantics, and getting
 * it subtly wrong produces a document that never existed. They count as revisions; the content we
 * keep is content the tool actually carried.
 */
export function authoredDocuments(messages: readonly unknown[]): readonly AuthoredDoc[] {
  const byKey = new Map<string, AuthoredDoc>();

  const record = (key: string, title: string, content: string, createdAt: string | undefined) => {
    const prior = byKey.get(key);
    byKey.set(key, {
      key,
      title: title.slice(0, MAX_TITLE),
      content,
      revisions: prior === undefined ? 0 : prior.revisions + 1,
      createdAt: prior?.createdAt ?? createdAt,
    });
  };

  for (const message of messages) {
    if (message === null || typeof message !== 'object') continue;
    const content = (message as Record<string, unknown>)['content'];
    if (!Array.isArray(content)) continue;
    const messageAt = asString((message as Record<string, unknown>)['created_at']);

    for (const block of content) {
      if (block === null || typeof block !== 'object') continue;
      const b = block as Record<string, unknown>;
      if (b['type'] !== 'tool_use') continue;
      const input = b['input'];
      if (input === null || typeof input !== 'object') continue;
      const i = input as Record<string, unknown>;

      if (b['name'] === 'artifacts') {
        const body = asString(i['content']);
        const id = asString(i['id']);
        // An update with no content is an edit to something recorded earlier, not a new document.
        if (body === undefined || id === undefined) continue;
        record(id, asString(i['title']) ?? id, body, messageAt);
        continue;
      }

      if (b['name'] === 'create_file') {
        const body = asString(i['file_text']);
        const path = asString(i['path']);
        if (body === undefined || path === undefined) continue;
        // The basename is the document's name; the sandbox directory it was written into
        // (`/home/claude`, `/mnt/user-data/outputs`) is an implementation detail of the tool.
        const name = path.slice(path.lastIndexOf('/') + 1);
        record(path, name === '' ? path : name, body, messageAt);
      }
    }
  }

  return [...byKey.values()];
}

/**
 * Renders a conversation as Markdown.
 *
 * A transcript, not a summary: the whole point of importing these is that the reasoning is in the
 * back-and-forth. Speakers are `## ` headings so the Reader's existing Markdown rendering gives the
 * turn structure for free, and so `deriveExcerpt`'s heading-skipping picks up the first real prose
 * rather than the word "Human".
 */
export function renderTranscript(messages: readonly unknown[]): string {
  const out: string[] = [];
  for (const message of messages) {
    const text = messageText(message);
    if (text === undefined) continue;
    const sender = (message as Record<string, unknown>)['sender'];
    const label = SPEAKER[typeof sender === 'string' ? sender : ''] ?? 'Message';
    out.push(`## ${label}\n\n${text}`);
  }
  return out.join('\n\n');
}

/**
 * The title of a conversation.
 *
 * Claude names most threads `Untitled`, so `name` alone would file a whole import under one
 * indistinguishable label — the single worst outcome for a product whose job is finding things
 * again. Falling back to the opening human turn is what a person would call the conversation
 * themselves.
 */
export function conversationTitle(name: unknown, transcript: string): string {
  const declared = asString(name);
  if (declared !== undefined && declared.toLowerCase() !== 'untitled') {
    return declared.slice(0, MAX_TITLE);
  }

  const firstProse = transcript
    .split('\n')
    .find((line) => line.trim() !== '' && !line.startsWith('#'));
  const opener = firstProse?.trim().replace(/\s+/g, ' ');
  if (opener === undefined || opener === '') return 'Untitled conversation';

  // One line, not one sentence: a first turn is frequently a pasted wall of text with no full stop
  // for two thousand characters, and MAX_TITLE alone would leave a title that is a truncated essay.
  return (opener.length > 80 ? `${opener.slice(0, 79).trimEnd()}…` : opener).slice(0, MAX_TITLE);
}

export interface ClaudeExportOptions {
  readonly maxBytes?: number;
  /**
   * Conversation uuid → project name, from the export's `projects.json`.
   *
   * Optional: a user who exports only conversations still gets a working import, filed under the
   * fallback folder rather than refused.
   */
  readonly projectsByConversation?: ReadonlyMap<string, string>;
  /** Fallback folder for conversations that belong to no project. */
  readonly defaultFolder?: string;
  /**
   * What a conversation contributes to the vault.
   *
   * `documents` — only what Claude authored. The default, because it is what this source is *for*:
   * Strata is an engineering knowledge base, and a thread about vitamin dosages that produced no
   * document is not a knowledge-base entry. Importing 72 conversations to find 32 documents buried
   * inside them is the wrong shape, and it is what this adapter did until D34.
   *
   * `transcripts` — the original behaviour, the back-and-forth as one document per thread.
   * `both` — a document per artifact AND the transcript. Not the default: the artifact content is
   * quoted verbatim inside the transcript, so `both` puts every document in the vault twice, which
   * is worth having only when the reasoning around a document matters as much as the document.
   */
  readonly include?: 'documents' | 'transcripts' | 'both';
}

export interface ClaudeScanResult {
  readonly pending: readonly PendingDoc[];
  readonly failures: readonly { readonly externalId: string; readonly code: ClaudeErrorCode }[];
}

/**
 * Parses a Claude `conversations.json` export into `PendingDoc`s.
 *
 * Takes already-read text rather than a filesystem port: this is one file the user hands us, not a
 * tree to walk, and a port here would be ceremony around `readFile`.
 *
 * A per-conversation failure never fails the import — the same rule the Markdown scan follows, and
 * for the same reason: one malformed conversation in an export of nine hundred must not lose the
 * other eight hundred and ninety-nine.
 */
export function scanClaudeExport(
  raw: string,
  sourceId: SourceId,
  options: ClaudeExportOptions = {},
): ClaudeScanResult {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const include = options.include ?? 'documents';
  const defaultFolder =
    options.defaultFolder ?? (include === 'documents' ? 'Documents' : 'Conversations');

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // The caught error is discarded, not surfaced. A JSON parse error quotes the text it choked on,
    // and that text is the user's private conversation (ADR 0003's sanitized-message rule).
    throw new ClaudeExportError('export-invalid');
  }
  // The whole-file shape IS an error, unlike a per-conversation one: pointing this at the wrong file
  // from the export ZIP is the most likely mistake, and reporting "0 imported" for it would be
  // indistinguishable from an empty account.
  if (!Array.isArray(parsed)) throw new ClaudeExportError('export-invalid');

  const pending: PendingDoc[] = [];
  const failures: { externalId: string; code: ClaudeErrorCode }[] = [];
  const seen = new Set<string>();

  for (const entry of parsed) {
    let externalId = '';
    try {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new ClaudeExportError('conversation-invalid');
      }
      const c = entry as Record<string, unknown>;

      // `uuid`, with `id` accepted as an alias. No fallback to an array index: an index is not an
      // identity, and using one would make every re-export of a vault where one conversation was
      // deleted rewrite the identity of every conversation after it.
      const id = asString(c['uuid']) ?? asString(c['id']);
      if (id === undefined) throw new ClaudeExportError('conversation-invalid');
      externalId = id;

      // Two conversations claiming one uuid should not happen, and if it does, the second must not
      // silently overwrite the first — the exact defect the Markdown adapter shipped with.
      if (seen.has(externalId)) throw new ClaudeExportError('duplicate-identity');
      seen.add(externalId);

      const messages = Array.isArray(c['chat_messages'])
        ? (c['chat_messages'] as unknown[])
        : Array.isArray(c['messages'])
          ? (c['messages'] as unknown[])
          : [];

      const project = options.projectsByConversation?.get(externalId);
      const folder: Derived<string> = {
        value: (project ?? defaultFolder).slice(0, MAX_FOLDER),
        // A project is where a human filed it — authored, not guessed. The fallback is the guess.
        provenance: project === undefined ? 'heuristic' : 'source',
        derivedAt: asString(c['updated_at']) ?? new Date(0).toISOString(),
      };

      const createdAt = asString(c['created_at']) ?? new Date(0).toISOString();
      const updatedAt = asString(c['updated_at']) ?? createdAt;

      /**
       * Documents Claude authored in this thread, each its own vault entry.
       *
       * Identity is `<conversation uuid>/<artifact id or path>`. Qualified by the conversation
       * because a path like `/home/claude/build.js` is reused across unrelated threads — three of
       * them in the export that surfaced this — and an unqualified path would make them one
       * document that overwrites itself on every import.
       */
      let produced = 0;
      if (include !== 'transcripts') {
        for (const doc of authoredDocuments(messages)) {
          const docId = `${externalId}/${doc.key}`;
          if (seen.has(docId)) continue;
          seen.add(docId);
          if (Buffer.byteLength(doc.content, 'utf8') > maxBytes) {
            failures.push({ externalId: docId, code: 'too-large' });
            continue;
          }
          const body = normalizeIngested(doc.content);
          const at = doc.createdAt ?? createdAt;
          pending.push({
            sourceId,
            externalId: docId,
            // The thread's name is NOT hashed here, unlike the transcript case. A document's identity
            // is the document — renaming the conversation it was written in does not revise it.
            contentHash: contentHash([doc.title, folder.value, doc.content].join('\u0000')),
            title: normalizeIngested(doc.title),
            excerpt: {
              value: normalizeIngested(firstProse(body)),
              provenance: 'heuristic',
              derivedAt: updatedAt,
            },
            folder: { ...folder, value: normalizeIngested(folder.value) },
            tags: { value: EMPTY_TAGS, provenance: 'heuristic', derivedAt: updatedAt },
            createdAt: at,
            updatedAt,
            body,
          });
          produced += 1;
        }
      }

      // A conversation that authored nothing is not a failure in documents mode — most conversations
      // are just conversations. Reporting 60 failures for an ordinary export would bury the few that
      // are real, which is the whole point of the failures channel.
      if (include === 'documents') continue;

      const transcript = renderTranscript(messages);
      // In `both` mode a thread whose only content is an authored document has an empty transcript
      // and is not empty in any sense the user would recognise — the document was already pushed.
      if (transcript.trim() === '') {
        if (produced > 0) continue;
        throw new ClaudeExportError('empty');
      }
      if (Buffer.byteLength(transcript, 'utf8') > maxBytes) throw new ClaudeExportError('too-large');

      const normalizedBody = normalizeIngested(transcript);

      // Hashed over EVERY input the stored document derives from — the conversation's name and its
      // folder as well as the transcript — and not from the raw JSON object.
      //
      // Not the object, because a re-export of an unchanged thread must produce the same hash, and
      // the export carries fields that move between exports without the conversation changing.
      //
      // Not the transcript alone, which is what this shipped as for about ten minutes. The title
      // derives from `name`, and `name` is not in the transcript — so renaming a conversation
      // produced an identical hash, the pipeline decided `unchanged`, nothing was written, and the
      // vault kept the old title forever while the run reported success. Caught by running the CLI
      // twice, not by a unit test: the adapter was correct in isolation and the LOOP was wrong.
      //
      // The rule is "hash every input the document derives from". The Markdown adapter was cited
      // here as having always had it right; it did not — its hash covered the file's bytes while
      // `folder` also derives from the scan root's NAME, which is not in the file. Same bug, same
      // shape, found the same way, fixed in D30.
      const hash = contentHash([asString(c['name']) ?? '', folder.value, transcript].join('\u0000'));

      pending.push({
        sourceId,
        externalId,
        contentHash: hash,
        title: normalizeIngested(conversationTitle(c['name'], normalizedBody)),
        excerpt: {
          value: normalizeIngested(firstProse(normalizedBody)),
          // Always heuristic. The export declares no summary, so there is nothing authored to
          // prefer — and claiming `source` would tell the ranker this excerpt was written for the
          // purpose, which weights it above body text it is merely a slice of (ADR 0004).
          provenance: 'heuristic',
          derivedAt: updatedAt,
        },
        folder: { ...folder, value: normalizeIngested(folder.value) },
        // No authored tags exist in the export. `[]` with `heuristic` provenance says "the rule ran
        // and found none", which is the truth; omitting the field would say nothing ran.
        tags: { value: EMPTY_TAGS, provenance: 'heuristic', derivedAt: updatedAt },
        createdAt,
        updatedAt,
        body: normalizedBody,
      });
    } catch (e) {
      failures.push({
        externalId,
        code: e instanceof ClaudeExportError ? e.code : 'conversation-invalid',
      });
    }
  }

  return { pending, failures };
}

/** First real prose line, skipping the speaker headings the transcript renders. */
function firstProse(transcript: string): string {
  for (const line of transcript.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    return trimmed.slice(0, MAX_EXCERPT);
  }
  return '';
}

/**
 * Builds the conversation → project-name map from the export's `projects.json`.
 *
 * Tolerant by design and silent on failure: a missing or unfamiliar `projects.json` costs the user
 * their folders, not their import. Refusing the whole import because an optional file changed shape
 * would be the wrong trade for a format nobody has promised us.
 */
export function projectFolders(raw: string): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return out;
  }
  if (!Array.isArray(parsed)) return out;

  for (const entry of parsed) {
    if (entry === null || typeof entry !== 'object') continue;
    const p = entry as Record<string, unknown>;
    const name = asString(p['name']);
    if (name === undefined) continue;

    const docs = p['conversations'] ?? p['docs'];
    if (!Array.isArray(docs)) continue;
    for (const d of docs) {
      const id =
        typeof d === 'string'
          ? d
          : d !== null && typeof d === 'object'
            ? asString((d as Record<string, unknown>)['uuid'])
            : undefined;
      if (id !== undefined) out.set(id, name);
    }
  }
  return out;
}
