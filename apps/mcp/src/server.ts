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
import type { Scope } from '@strata/core';
import type { DocStore, SourceStore } from '@strata/storage';
import { TOOL_SCHEMAS, ToolError, getDoc, listSources, searchDocs } from './tools.ts';

export interface ServerDeps {
  readonly docs: DocStore;
  readonly sources: SourceStore;
  /**
   * Resolved per connection, upstream of this module.
   *
   * A `Scope` must not be cached across requests — a cached one is a `Grant` revocation that
   * silently does not take effect (see `Scope`'s doc comment). This is a function, not a value,
   * so a longer-lived server can re-resolve it per call once auth exists.
   */
  scope(): Scope;
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
    // Re-resolved per call, never held.
    const scope = deps.scope();
    const input = (args ?? {}) as Record<string, unknown>;

    try {
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
      // Only ToolError messages cross the boundary. Anything else - a driver error, a bug - would
      // otherwise leak schema names, SQL, or ids into a model's context.
      return failure(e instanceof ToolError ? e.message : 'InternalError');
    }
  });

  return server;
}
