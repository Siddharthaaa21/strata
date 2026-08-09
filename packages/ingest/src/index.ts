/**
 * Ingestion pipeline.
 *
 * STATUS: not implemented (milestone M5). This file declares the boundary so adapters have a
 * contract to build against; see .claude/agents/strata-ingest-engineer.md for the rules.
 *
 *   fetch (adapter, per source) -> RawDoc -> normalize (shared) -> dedupe -> persist -> ImportEvent
 *
 * Adapters are the ONLY source-specific code. A `if (source === 'github')` branch inside the
 * normalizer means the abstraction is wrong — push it back into the adapter.
 */

import type { SourceId, SourceKind } from '@strata/core';

/**
 * What an adapter returns. Untrusted: `rawMarkdown` is arbitrary text written by a human or a
 * model, and it will later be read BY a model. It must never reach a prompt, a tool description,
 * or a control-flow decision unfenced. See docs/plan/04-risk-register.md R2.
 */
export interface RawDoc {
  readonly sourceId: SourceId;
  readonly externalId: string;
  readonly rawMarkdown: string;
  /** ISO-8601 UTC. */
  readonly fetchedAt: string;
  readonly sourceMeta: Readonly<Record<string, unknown>>;
}

export interface FetchPage {
  readonly docs: readonly RawDoc[];
  /** Opaque continuation token. Every source is assumed to paginate and to rate-limit. */
  readonly cursor?: string;
}

/**
 * Adapters are pure fetch + shape. No persistence, no dedupe, no tagging.
 *
 * Every source is assumed to deliver at-least-once and out of order, so the pipeline downstream
 * dedupes on (sourceId, externalId, contentHash). Adapters do not need to be exactly-once.
 */
export interface SourceAdapter {
  readonly kind: SourceKind;
  fetchPage(sourceId: SourceId, cursor?: string): Promise<FetchPage>;
}

/** Per-doc failures must not fail a batch — they surface as failed ImportEvents. */
export interface IngestOutcome {
  readonly attempted: number;
  readonly succeeded: number;
  readonly failures: readonly { readonly externalId: string; readonly code: string }[];
}

export * from './fs-port.ts';
export * from './markdown.ts';
// The Claude export adapter deliberately does NOT implement `SourceAdapter` above — there is no API
// to page through, so the interface would describe nothing. See D22 and `adapter-claude`.
export * from './claude.ts';
export * from './pipeline.ts';
export * from './persist.ts';
