/**
 * Strata MCP server — how agents read the vault.
 *
 * STATUS: not implemented (milestone M6). BLOCKED on risk-tenancy and risk-injection.
 * Read .claude/skills/mcp-surface/SKILL.md before adding anything here.
 *
 * The surface is read-only by decision (docs/plan/05-decision-log.md D5). Adding tools later is
 * additive and safe; removing them breaks agent workflows silently.
 *
 * Non-negotiable properties of every tool added here:
 *   1. It re-checks caller scope ITSELF. Not in middleware, not in the caller.
 *   2. It returns document content fenced as data, never as prose the model may read as
 *      instruction.
 *   3. "not found" and "not permitted" are indistinguishable to the caller — otherwise the error
 *      channel is an enumeration oracle over document ids.
 *   4. Its description contains no interpolated ingested content.
 */

export const PLANNED_TOOLS = [
  'search_docs', // (query, filters?, limit?) -> metadata + excerpt. Never bodies.
  'get_doc', // (doc_id) -> body + metadata. Re-checks scope. Fenced.
  'list_sources', // () -> connected sources. Never credentials.
] as const;

export type PlannedTool = (typeof PLANNED_TOOLS)[number];
