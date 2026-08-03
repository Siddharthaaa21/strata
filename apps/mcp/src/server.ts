/**
 * MCP server wiring. Thin by design — every security property lives in `./tools.ts`, which is
 * testable without a transport.
 *
 * The server is constructed with a `Scope` and the stores rather than reaching for globals, so an
 * end-to-end test can drive it over an in-memory transport against PGlite. That is what makes
 * "a real MCP client can search and read the vault" checkable without a hosted database.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import { AuthError } from '@strata/auth';
import type { Scope } from '@strata/core';
import type { ReadonlyDocStore, ReadonlySourceStore } from '@strata/storage';
import { TOOL_SCHEMAS, ToolError, getDoc, listSources, searchDocs } from './tools.ts';

/**
 * The read-only slice of the stores this server is allowed to see.
 *
 * D5 says no mutating tool exists. That was true because nobody had written one — a property held by
 * the absence of a line of code, which is the weakest way to hold anything. Handing the server a
 * `Pick` of the read methods makes it true at the type level instead: `upsert` is not reachable from
 * here because it was never passed in.
 *
 * This is also what lets `Grant.sourceIds` stay a single dimension covering reads and writes, with
 * no `capabilities: ('read'|'write')[]` axis (ADR 0006 §6). Widening either type below is the
 * trigger to revisit that decision — see R11.
 */
export type { ReadonlyDocStore, ReadonlySourceStore };

export interface ServerDeps {
  readonly docs: ReadonlyDocStore;
  readonly sources: ReadonlySourceStore;
  /**
   * Resolved per call, never held.
   *
   * Async because it is now a credential verification — one indexed lookup, no cache. The maximum
   * legitimate cache TTL is the revocation latency the Agent Access screen promises, and it promises
   * immediate (ADR 0006 §4). A cached `Scope` is a `Grant` revocation that never takes effect.
   */
  scope(): Promise<Scope>;
}

const json = (value: unknown): CallToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
});

/**
 * Errors are returned as `isError` results with the bare message, never as thrown exceptions
 * carrying a stack. A stack trace names files and ids; `NotFound` names nothing.
 */
const failure = (message: string): CallToolResult => ({
  content: [{ type: 'text', text: message }],
  isError: true,
});

export function createStrataServer(deps: ServerDeps): Server {
  const server = new Server(
    { name: 'strata', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: Object.values(TOOL_SCHEMAS).map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const { name, arguments: args } = request.params;
    const input = (args ?? {}) as Record<string, unknown>;

    try {
      // Inside the try, deliberately: verification can now fail, and an AuthError escaping this
      // handler would surface as a transport-level crash instead of a tool result.
      const scope = await deps.scope();

      switch (name) {
        case 'search_docs':
          return json(await searchDocs(scope, deps.docs, input));
        case 'get_doc':
          return json(await getDoc(scope, deps.docs, input));
        case 'list_sources':
          return json(await listSources(scope, deps.sources));
        default:
          return failure('UnknownTool');
      }
    } catch (e) {
      // Every authentication failure kind — malformed, unknown, revoked, expired — collapses to one
      // word. The `kind` exists for our own logs; returning it would let someone probe which token
      // ids are real.
      //
      // `Unauthorized` IS distinguishable from `NotFound`, and that is a reasoned exception to
      // mcp-surface rule 5 rather than an oversight. Rule 5 exists so the error channel is not an
      // enumeration oracle *over document ids*; a caller learning that their own credential is bad
      // enumerates nothing, since they already hold it. Collapsing the two would make a revoked
      // agent indistinguishable from an empty vault — an unresolvable support problem. The oracle
      // boundary is facts about the vault, not facts about the caller's own credential.
      if (e instanceof AuthError) return failure('Unauthorized');

      // Only ToolError messages cross the boundary. Anything else - a driver error, a bug - would
      // otherwise leak schema names, SQL, or ids into a model's context.
      return failure(e instanceof ToolError ? e.message : 'InternalError');
    }
  });

  return server;
}
