export const meta = {
  name: 'design-panel',
  description: 'Generate independent competing designs for one hard decision, judge them, synthesize a recommendation',
  whenToUse: 'For architecture decisions that are expensive to reverse — the MCP surface, the Doc contract, tenancy, storage/search. Pass args: { question, constraints? }.',
  phases: [
    { title: 'Propose', detail: 'independent designs from deliberately different angles' },
    { title: 'Judge', detail: 'each design scored by independent judges on distinct criteria' },
    { title: 'Synthesize', detail: 'recommend the winner, graft the best ideas from the rest' },
  ],
}

const question = args?.question
if (!question) throw new Error('args.question is required — state the decision to be made')
const constraints = args?.constraints ?? 'See docs/plan/ for committed constraints.'

// Diverse angles beat N runs of the same prompt. Each proposer optimizes for something different.
const ANGLES = [
  { key: 'agent-first', lens: 'Optimize for the AI agent consumer over MCP. Assume agents are the primary reader and humans secondary. What shape makes retrieval cheap and relevance decidable from metadata alone?' },
  { key: 'simplest', lens: 'Optimize for the smallest thing that could work. Assume the team is small and the product is pre-PMF. What can be deferred without painting us into a corner?' },
  { key: 'migration-safe', lens: 'Optimize for the version of this that is still right in two years. Where are the extension points, and what does the migration look like if we are wrong?' },
]

const DESIGN = {
  type: 'object',
  required: ['decision', 'design', 'rejected', 'migrationRisk', 'open'],
  properties: {
    decision: { type: 'string' },
    design: { type: 'string', description: 'concrete shapes, signatures, boundaries' },
    rejected: { type: 'array', items: { type: 'string' } },
    migrationRisk: { type: 'string', enum: ['low', 'medium', 'high'] },
    open: { type: 'array', items: { type: 'string' }, description: 'genuinely unresolved — never fill with guesses' },
  },
}

const SCORE = {
  type: 'object',
  required: ['score', 'reasoning', 'fatalFlaw'],
  properties: {
    score: { type: 'number', description: '1-10' },
    reasoning: { type: 'string' },
    fatalFlaw: { type: 'string', description: 'empty string if none found' },
  },
}

const CRITERIA = [
  'agent ergonomics: can an MCP client actually do useful retrieval with this?',
  'security: does this make tenancy leaks or prompt injection easier or harder?',
  'cost of being wrong: what breaks in six months, and how expensive is the migration?',
]

log(`Design panel on: ${question}`)

const judged = await pipeline(
  ANGLES,
  (a) =>
    agent(
      `Design a solution to this Strata decision.

       QUESTION: ${question}
       CONSTRAINTS: ${constraints}
       YOUR ANGLE: ${a.lens}

       Read docs/plan/01-north-star.md, 03-data-contracts.md, 04-risk-register.md and
       05-decision-log.md first. Do not reopen a settled decision without saying so.
       Commit to your angle — the panel's value is that the proposals genuinely differ.
       Be concrete: real types and signatures, not principles.
       Leave "open" honest. An unresolved unknown is worth more than a confident guess.`,
      { label: `propose:${a.key}`, phase: 'Propose', agentType: 'strata-architect', schema: DESIGN },
    ),

  (design, angle) =>
    parallel(
      CRITERIA.map((c) => () =>
        agent(
          `Score this design on exactly one criterion: ${c}

           Ignore every other dimension. Be harsh — a design that scores 8 everywhere has not
           been read carefully. Name a fatalFlaw only if you can state the concrete scenario
           where it fails.

           ${JSON.stringify(design, null, 2)}`,
          { label: `judge:${angle.key}:${c.split(':')[0]}`, phase: 'Judge', effort: 'high', schema: SCORE },
        ),
      ),
    ).then((scores) => {
      const valid = scores.filter(Boolean)
      const total = valid.reduce((sum, s) => sum + s.score, 0)
      return {
        angle: angle.key,
        design,
        scores: valid,
        total,
        fatal: valid.filter((s) => s.fatalFlaw && s.fatalFlaw.trim()).map((s) => s.fatalFlaw),
      }
    }),
)

const ranked = judged.filter(Boolean).sort((a, b) => b.total - a.total)
if (!ranked.length) return { question, error: 'no designs survived' }

ranked.forEach((r) => log(`${r.angle}: ${r.total} (${r.fatal.length} fatal flaws)`))

phase('Synthesize')
const recommendation = await agent(
  `Synthesize a recommendation for: ${question}

   Three designs were proposed and independently judged. Ranked:
   ${JSON.stringify(ranked, null, 2)}

   Recommend the winner, but graft in any genuinely better idea from the runners-up and say
   which you took and why. Address every fatalFlaw raised — either it is wrong (say why) or the
   recommendation handles it (say how). Do not paper over one.

   Output in the format of .claude/agents/strata-architect.md — DECISION / CONSTRAINTS / DESIGN /
   REJECTED / MIGRATION RISK / OPEN / FOLLOW-UP. FOLLOW-UP must name the decision-log entry and
   context-graph nodes to write.`,
  { label: 'synthesize', agentType: 'strata-architect', effort: 'max' },
)

return { question, ranked, recommendation }
