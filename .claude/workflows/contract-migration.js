export const meta = {
  name: 'contract-migration',
  description: 'Propagate a packages/core shape change to every consumer, in isolation, then verify',
  whenToUse: 'After changing a domain type in packages/core. Pass args: { node: "contract-doc", change: "<what changed>" }.',
  phases: [
    { title: 'Discover', detail: 'find every consumer via the context graph and the code' },
    { title: 'Migrate', detail: 'one isolated agent per consumer' },
    { title: 'Gate', detail: 'run npm run verify on the merged result' },
  ],
}

const node = args?.node ?? 'contract-doc'
const change = args?.change
if (!change) throw new Error('args.change is required — describe what changed in the shape')

const CONSUMERS = {
  type: 'object',
  required: ['consumers'],
  properties: {
    consumers: {
      type: 'array',
      items: {
        type: 'object',
        required: ['file', 'why'],
        properties: {
          file: { type: 'string' },
          why: { type: 'string' },
          isPublishedInterface: {
            type: 'boolean',
            description: 'true for MCP tool schemas and anything else external clients depend on',
          },
        },
      },
    },
  },
}

phase('Discover')
const found = await agent(
  `Find every consumer of the "${node}" contract in this repo.
   Start with: node scripts/graph.mjs --impact ${node}
   Then confirm against the code — the graph is hand-maintained and may be stale.
   Search apps/web, apps/mcp, packages/ingest.
   Mark isPublishedInterface true for MCP tool schemas: those are an external contract and a
   silent break there is worse than a compile error.
   Report every hit. Do not sample.`,
  { label: 'discover-consumers', agentType: 'strata-scout', schema: CONSUMERS },
)

const consumers = found?.consumers ?? []
if (!consumers.length) {
  log(`No consumers found for ${node} — nothing to migrate.`)
  return { migrated: [], note: 'no consumers' }
}

const published = consumers.filter((c) => c.isPublishedInterface)
log(`${consumers.length} consumers (${published.length} published interfaces) for ${node}`)
if (published.length) {
  log(`Published interfaces need a versioning decision, not just an edit: ${published.map((c) => c.file).join(', ')}`)
}

phase('Migrate')
// Worktree isolation: these agents write in parallel and would otherwise conflict.
const results = await parallel(
  consumers.map((c) => () =>
    agent(
      `Migrate ${c.file} for this change to the ${node} contract:

       ${change}

       This file is a consumer because: ${c.why}
       ${c.isPublishedInterface ? 'NOTE: this is a PUBLISHED interface (MCP tool schema). Do not silently rename or remove a field — additive changes only, and flag anything breaking instead of doing it.' : ''}

       Read packages/core for the new shape first. Change only what the contract change requires;
       do not refactor opportunistically. Run: npx tsc --noEmit
       Report the file, what you changed, and whether typecheck passed.`,
      { label: `migrate:${c.file}`, phase: 'Migrate', isolation: 'worktree' },
    ).then((out) => ({ file: c.file, out })),
  ),
)

const migrated = results.filter(Boolean)
log(`${migrated.length}/${consumers.length} consumers migrated`)

phase('Gate')
const gate = await agent(
  `Run \`npm run verify\` in the repo root and report the result verbatim.
   If it fails, identify which migrated file caused it. Do not fix anything — report only.
   Migrated files: ${migrated.map((m) => m.file).join(', ')}`,
  { label: 'verify-gate', effort: 'high' },
)

return { node, change, consumers, migrated, published, gate }
