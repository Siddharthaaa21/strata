/**
 * The access log (ADR 0005 section 5).
 *
 * ADR 0005 admits in its own Open items that fencing reduces likelihood and blast radius without
 * eliminating injection, and names logging as the compensating control. That control was specified
 * and then not built for the whole of M6 — so an injection that succeeded left no record at all.
 * This is that gap closed.
 *
 * TWO RULES, and the first one is why this is a separate module rather than three lines in the
 * server:
 *
 *   1. **Never store content.** A log holding the payload is a second copy of the problem. It sits
 *      outside every fence, it is read by whoever is debugging an incident, and it inherits none of
 *      the retention that applies to documents. A hash answers "was this the same response" and
 *      cannot answer "what did it say", which is exactly the amount of power an audit trail needs.
 *
 *   2. **Recording must never fail the request it records.** Every call site is fire-and-forget.
 *      An audit trail that can take down the thing it audits is worse than none, because the outage
 *      arrives at exactly the moment the log is most interesting.
 */

import { createHash, randomUUID } from 'node:crypto';
import type { PrincipalId, WorkspaceId } from '@strata/core';
import type { SqlDriver } from './index.ts';

/** What happened. `ok` plus every error the MCP surface can return. */
export type AccessOutcome = 'ok' | 'NotFound' | 'InvalidInput' | 'Unauthorized' | 'InternalError' | 'UnknownTool';

export interface AccessEntry {
  /** Absent when authentication failed — there is no principal to attribute the call to. */
  readonly workspaceId?: WorkspaceId;
  readonly principalId?: PrincipalId;
  readonly tool: string;
  readonly outcome: AccessOutcome;
  /** Which documents the response actually carried. The point of the whole table. */
  readonly docIds?: readonly string[];
  /**
   * The response, for hashing ONLY. Never stored.
   *
   * Taken as the raw value rather than a pre-computed hash so no call site has to remember to hash
   * it — the one that forgets would be the one that logs the payload.
   */
  readonly response?: unknown;
}

export interface AccessLog {
  record(entry: AccessEntry): Promise<void>;
  /** For the Agent Access screen (increment 3) and for answering "who read this document". */
  recent(
    workspaceId: WorkspaceId,
    limit?: number,
  ): Promise<
    readonly {
      readonly id: string;
      readonly principalId?: PrincipalId;
      readonly tool: string;
      readonly outcome: AccessOutcome;
      readonly docIds: readonly string[];
      readonly occurredAt: string;
    }[]
  >;
}

export function createAccessLog(db: SqlDriver): AccessLog {
  return {
    async record(entry) {
      const hash =
        entry.response === undefined
          ? null
          : createHash('sha256').update(JSON.stringify(entry.response)).digest('hex');

      await db.query(
        `INSERT INTO access_log
           (id, workspace_id, principal_id, tool, outcome, doc_ids, result_hash, occurred_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          randomUUID(),
          entry.workspaceId ?? null,
          entry.principalId ?? null,
          entry.tool,
          entry.outcome,
          [...(entry.docIds ?? [])],
          hash,
          new Date().toISOString(),
        ],
      );
    },

    async recent(workspaceId, limit = 50) {
      const { rows } = await db.query<{
        id: string;
        principal_id: string | null;
        tool: string;
        outcome: string;
        doc_ids: string[];
        occurred_at: Date | string;
      }>(
        `SELECT id, principal_id, tool, outcome, doc_ids, occurred_at
           FROM access_log
          WHERE workspace_id = $1
          ORDER BY occurred_at DESC
          LIMIT $2`,
        [workspaceId, Math.max(1, Math.min(limit, 200))],
      );

      return rows.map((r) => ({
        id: r.id,
        ...(r.principal_id === null ? {} : { principalId: r.principal_id as PrincipalId }),
        tool: r.tool,
        outcome: r.outcome as AccessOutcome,
        docIds: r.doc_ids,
        occurredAt: new Date(r.occurred_at).toISOString(),
      }));
    },
  };
}

/**
 * Pulls document ids out of a tool response for the log.
 *
 * Deliberately structural rather than per-tool: a tool added later is covered without an edit, for
 * the same reason the fencing guard walks the whole result instead of a list of channels. Only
 * `doc_id` keys are collected — never a value, so no content can reach the log through here even by
 * accident.
 */
export function docIdsIn(value: unknown, out: string[] = []): readonly string[] {
  if (Array.isArray(value)) {
    for (const item of value) docIdsIn(item, out);
  } else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (key === 'doc_id' && typeof item === 'string') out.push(item);
      else docIdsIn(item, out);
    }
  }
  return out;
}
