/**
 * Fixture data for fixture-driven UI (docs/plan/05-decision-log.md D8).
 *
 * This is the ONLY place mock Doc/Source content should be authored. Screens and components
 * import from here — never inline placeholder strings ported from `design/handoff/Vault.dc.html`.
 * All copy below (titles, excerpts, connector descriptions) is invented for this codebase; it
 * intentionally does not reuse the handoff's own placeholder strings ("Priya Shah", "312 docs",
 * the sample ledger-service doc, etc).
 *
 * `Doc`/`Source` carry `workspaceId` (see ./index.ts, ADR 0002). All fixtures share a single
 * fixture workspace — there is no cross-workspace scoping to exercise here, since fixtures have
 * no query/store layer for a `Scope` to be checked against (decision log D8 still covers that gap).
 */
import type { BodyRef, Derived, Doc, DocId, ImportEvent, Source, SourceId, WorkspaceId } from './index';

const workspaceId = 'ws-fixture' as WorkspaceId;

function derived<T>(value: T, provenance: Derived<T>['provenance'], derivedAt: string): Derived<T> {
  return { value, provenance, derivedAt };
}

export const sources: readonly Source[] = [
  {
    id: 'src-claude' as SourceId,
    workspaceId,
    kind: 'claude',
    name: 'Claude',
    description: 'Syncs research threads and project docs.',
    status: 'connected',
    lastSyncAt: '2026-07-28T09:12:00Z',
  },
  {
    id: 'src-cursor' as SourceId,
    workspaceId,
    kind: 'cursor',
    name: 'Cursor',
    description: 'Pulls implementation plans from your repos.',
    status: 'connected',
    lastSyncAt: '2026-07-28T08:40:00Z',
  },
  {
    id: 'src-github' as SourceId,
    workspaceId,
    kind: 'github',
    name: 'GitHub',
    description: 'Indexes READMEs, ADRs, and PR descriptions.',
    // Ships disconnected by default — product decision, not an oversight. See D6 /
    // design/handoff/README.md:25.
    status: 'disconnected',
  },
  {
    id: 'src-markdown' as SourceId,
    workspaceId,
    kind: 'markdown',
    name: 'Local Markdown',
    description: 'Drag in .md files or folders from anywhere.',
    status: 'connected',
    lastSyncAt: '2026-07-27T22:05:00Z',
  },
] as const;

export const docs: readonly Doc[] = [
  {
    id: 'doc-backfill-idempotency' as DocId,
    workspaceId,
    sourceId: 'src-claude' as SourceId,
    externalId: 'claude-thread-8841',
    contentHash: 'sha256-mock-a1b2c3',
    title: 'Backfilling Idempotency Keys Without Downtime',
    excerpt: derived(
      'Draft plan for migrating the ledger write path to per-request idempotency keys without a maintenance window.',
      'model',
      '2026-07-28T09:41:00Z',
    ),
    folder: derived('Architecture', 'heuristic', '2026-07-28T09:41:00Z'),
    tags: derived(['ledger', 'migration', 'adr'], 'user', '2026-07-28T09:45:00Z'),
    updatedAt: '2026-07-28T09:40:00Z',
    createdAt: '2026-07-26T14:02:00Z',
    bodyRef: 'body-backfill-idempotency' as BodyRef,
  },
  {
    id: 'doc-rate-limiter-composer' as DocId,
    workspaceId,
    sourceId: 'src-cursor' as SourceId,
    externalId: 'cursor-composer-2291',
    contentHash: 'sha256-mock-d4e5f6',
    title: 'Composer Notes: Token-Bucket Rate Limiter',
    excerpt: derived(
      'Implementation plan for a shared rate-limiter middleware, including rollout and rollback steps.',
      'model',
      '2026-07-28T09:02:00Z',
    ),
    folder: derived('Incidents', 'heuristic', '2026-07-28T09:02:00Z'),
    tags: derived(['rate-limiting', 'middleware'], 'model', '2026-07-28T09:02:00Z'),
    updatedAt: '2026-07-28T09:02:00Z',
    createdAt: '2026-07-25T11:20:00Z',
    bodyRef: 'body-rate-limiter-composer' as BodyRef,
  },
  {
    id: 'doc-oncall-runbook-draft' as DocId,
    workspaceId,
    sourceId: 'src-markdown' as SourceId,
    externalId: 'md-oncall-runbook',
    contentHash: 'sha256-mock-g7h8i9',
    title: 'On-Call Escalation Runbook (Draft)',
    excerpt: derived(
      'Who to page, in what order, for each severity tier, plus a rollback checklist.',
      'source',
      '2026-07-27T20:00:00Z',
    ),
    folder: derived('Incidents', 'user', '2026-07-27T20:05:00Z'),
    tags: derived(['runbook', 'oncall'], 'user', '2026-07-27T20:05:00Z'),
    updatedAt: '2026-07-27T20:00:00Z',
    createdAt: '2026-07-20T09:00:00Z',
    bodyRef: 'body-oncall-runbook-draft' as BodyRef,
  },
  {
    id: 'doc-prompt-schema-review' as DocId,
    workspaceId,
    sourceId: 'src-claude' as SourceId,
    externalId: 'claude-thread-7723',
    contentHash: 'sha256-mock-j1k2l3',
    title: 'Prompt Recipe: Reviewing Schema Migrations',
    excerpt: derived(
      'Reusable prompt for catching backward-incompatible schema changes before merge.',
      'model',
      '2026-07-28T07:15:00Z',
    ),
    folder: derived('Prompt Recipes', 'heuristic', '2026-07-28T07:15:00Z'),
    tags: derived(['prompt', 'sql', 'review'], 'user', '2026-07-28T07:20:00Z'),
    updatedAt: '2026-07-28T07:15:00Z',
    createdAt: '2026-07-10T16:40:00Z',
    bodyRef: 'body-prompt-schema-review' as BodyRef,
  },
  {
    id: 'doc-dedup-index-strategy' as DocId,
    workspaceId,
    sourceId: 'src-cursor' as SourceId,
    externalId: 'cursor-composer-2043',
    contentHash: 'sha256-mock-m4n5o6',
    title: 'Dedup Table Index Strategy',
    excerpt: derived(
      'Comparing composite vs. covering indexes for the dedup lookup table under write-heavy load.',
      'model',
      '2026-07-26T10:30:00Z',
    ),
    folder: derived('Architecture', 'heuristic', '2026-07-26T10:30:00Z'),
    tags: derived(['indexing', 'performance'], 'model', '2026-07-26T10:30:00Z'),
    updatedAt: '2026-07-26T10:30:00Z',
    createdAt: '2026-07-22T13:00:00Z',
    bodyRef: 'body-dedup-index-strategy' as BodyRef,
  },
  {
    id: 'doc-settlement-batching' as DocId,
    workspaceId,
    sourceId: 'src-claude' as SourceId,
    externalId: 'claude-thread-6650',
    contentHash: 'sha256-mock-p7q8r9',
    title: 'Settlement Batching: Hourly vs. Daily',
    excerpt: derived(
      'Cost and latency tradeoffs of moving settlement from daily to hourly batches.',
      'model',
      '2026-07-24T18:00:00Z',
    ),
    folder: derived('Research', 'heuristic', '2026-07-24T18:00:00Z'),
    tags: derived(['settlement', 'research'], 'model', '2026-07-24T18:00:00Z'),
    updatedAt: '2026-07-24T18:00:00Z',
    createdAt: '2026-07-18T09:30:00Z',
    bodyRef: 'body-settlement-batching' as BodyRef,
  },
  {
    id: 'doc-new-hire-dev-env' as DocId,
    workspaceId,
    sourceId: 'src-markdown' as SourceId,
    externalId: 'md-new-hire-setup',
    contentHash: 'sha256-mock-s1t2u3',
    title: 'New Hire Setup: Local Dev Environment',
    excerpt: derived(
      'Step-by-step for getting the monorepo running locally, including known gotchas.',
      'source',
      '2026-07-15T12:00:00Z',
    ),
    folder: derived('Onboarding', 'user', '2026-07-15T12:05:00Z'),
    tags: derived(['onboarding', 'dev-env'], 'user', '2026-07-15T12:05:00Z'),
    updatedAt: '2026-07-15T12:00:00Z',
    createdAt: '2026-06-30T08:00:00Z',
    bodyRef: 'body-new-hire-dev-env' as BodyRef,
  },
  {
    id: 'doc-prompt-postmortem-summary' as DocId,
    workspaceId,
    sourceId: 'src-claude' as SourceId,
    externalId: 'claude-thread-5502',
    contentHash: 'sha256-mock-v4w5x6',
    title: 'Prompt Recipe: Summarizing Postmortems',
    excerpt: derived(
      'A prompt template that condenses a postmortem doc into a five-bullet exec summary.',
      'model',
      '2026-07-14T15:45:00Z',
    ),
    folder: derived('Prompt Recipes', 'heuristic', '2026-07-14T15:45:00Z'),
    tags: derived(['prompt', 'postmortem'], 'user', '2026-07-14T15:50:00Z'),
    updatedAt: '2026-07-14T15:45:00Z',
    createdAt: '2026-06-28T10:10:00Z',
    bodyRef: 'body-prompt-postmortem-summary' as BodyRef,
  },
  {
    id: 'doc-webhook-backoff-tuning' as DocId,
    workspaceId,
    sourceId: 'src-cursor' as SourceId,
    externalId: 'cursor-composer-1888',
    contentHash: 'sha256-mock-y7z8a9',
    title: 'Webhook Retry Backoff Tuning',
    excerpt: derived(
      "Notes from tuning exponential backoff parameters after last week's webhook storm.",
      'model',
      '2026-07-12T09:20:00Z',
    ),
    folder: derived('Incidents', 'heuristic', '2026-07-12T09:20:00Z'),
    tags: derived(['webhooks', 'reliability'], 'model', '2026-07-12T09:20:00Z'),
    updatedAt: '2026-07-12T09:20:00Z',
    createdAt: '2026-07-05T17:00:00Z',
    bodyRef: 'body-webhook-backoff-tuning' as BodyRef,
  },
  {
    id: 'doc-access-review-checklist' as DocId,
    workspaceId,
    sourceId: 'src-markdown' as SourceId,
    externalId: 'md-access-review-checklist',
    contentHash: 'sha256-mock-b1c2d3',
    title: 'Access Review Checklist for New Services',
    excerpt: derived(
      'Checklist for provisioning least-privilege access when standing up a new service.',
      'source',
      '2026-07-08T13:10:00Z',
    ),
    folder: derived('Onboarding', 'user', '2026-07-08T13:15:00Z'),
    tags: derived(['security', 'onboarding'], 'user', '2026-07-08T13:15:00Z'),
    updatedAt: '2026-07-08T13:10:00Z',
    createdAt: '2026-06-20T09:00:00Z',
    bodyRef: 'body-access-review-checklist' as BodyRef,
  },
] as const;

/**
 * One record per ingestion attempt (contract-import-event), for the Import & Sources screen's
 * "Recent imports" list. Deliberately a mix of every `ImportEvent.status` — `skipped-duplicate`
 * is a normal idempotent-reimport outcome, not an error (see packages/core/src/index.ts), and
 * `failed` has no `docId` here because the GitHub source is disconnected (D6) and the failure
 * happened before any Doc could exist.
 */
export const importEvents: readonly ImportEvent[] = [
  {
    id: 'evt-backfill-idempotency',
    workspaceId,
    sourceId: 'src-claude' as SourceId,
    docId: 'doc-backfill-idempotency' as DocId,
    status: 'imported',
    occurredAt: '2026-07-28T09:41:00Z',
  },
  {
    id: 'evt-rate-limiter-composer',
    workspaceId,
    sourceId: 'src-cursor' as SourceId,
    docId: 'doc-rate-limiter-composer' as DocId,
    status: 'updated',
    occurredAt: '2026-07-28T09:02:00Z',
  },
  {
    id: 'evt-oncall-runbook-draft',
    workspaceId,
    sourceId: 'src-markdown' as SourceId,
    docId: 'doc-oncall-runbook-draft' as DocId,
    status: 'skipped-duplicate',
    occurredAt: '2026-07-27T20:00:00Z',
  },
  {
    id: 'evt-prompt-schema-review',
    workspaceId,
    sourceId: 'src-claude' as SourceId,
    docId: 'doc-prompt-schema-review' as DocId,
    status: 'imported',
    occurredAt: '2026-07-28T07:15:00Z',
  },
  {
    id: 'evt-github-auth-expired',
    workspaceId,
    sourceId: 'src-github' as SourceId,
    status: 'failed',
    error: { code: 'auth_expired', message: 'GitHub credential expired before sync could start.' },
    occurredAt: '2026-07-28T06:00:00Z',
  },
] as const;
