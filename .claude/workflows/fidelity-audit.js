export const meta = {
  name: 'fidelity-audit',
  description: 'Audit implemented Strata UI against the design handoff, then adversarially verify each finding',
  whenToUse: 'After a UI milestone, or before calling any screen done. Pass args as an array of targets, e.g. ["screen-library","screen-reader"].',
  phases: [
    { title: 'Audit', detail: 'one auditor per target, against the handoff' },
    { title: 'Verify', detail: 'refute each finding before it is reported' },
    { title: 'Synthesize', detail: 'merge surviving findings into one ranked report' },
  ],
}

const TARGETS = Array.isArray(args) && args.length
  ? args
  : ['screen-library', 'screen-import', 'screen-reader']

const FINDINGS = {
  type: 'object',
  required: ['findings', 'matchedCount'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['file', 'line', 'dimension', 'spec', 'actual', 'severity'],
        properties: {
          file: { type: 'string' },
          line: { type: 'number' },
          dimension: { type: 'string', enum: ['color', 'type', 'spacing', 'radius', 'layout', 'responsive', 'state'] },
          spec: { type: 'string', description: 'handoff value + source file:line' },
          actual: { type: 'string' },
          severity: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
      },
    },
    matchedCount: { type: 'number' },
    unverifiable: { type: 'array', items: { type: 'string' } },
  },
}

const VERDICT = {
  type: 'object',
  required: ['refuted', 'reason'],
  properties: {
    refuted: { type: 'boolean' },
    reason: { type: 'string' },
    handoffInternalConflict: {
      type: 'boolean',
      description: 'true if README and Vault.dc.html disagree — a product decision, not a code bug',
    },
  },
}

log(`Auditing ${TARGETS.length} target(s) against design/handoff`)

// Pipeline, not barrier: each target's findings verify as soon as that audit lands.
const perTarget = await pipeline(
  TARGETS,
  (target) =>
    agent(
      `Audit the implementation of "${target}" in apps/web against the Strata design handoff.
       Read design/handoff/README.md AND the corresponding block of design/handoff/Vault.dc.html.
       Where they disagree the HTML wins — but record the disagreement.
       Check every dimension in .claude/agents/strata-fidelity-auditor.md.
       Report only findings where you have read both the spec value and the code value.`,
      { label: `audit:${target}`, phase: 'Audit', agentType: 'strata-fidelity-auditor', schema: FINDINGS },
    ),

  (audit, target) => {
    if (!audit?.findings?.length) {
      log(`${target}: clean (${audit?.matchedCount ?? 0} values verified)`)
      return []
    }
    return parallel(
      audit.findings.map((f) => () =>
        agent(
          `Try to REFUTE this design-fidelity finding. Default to refuted:true if uncertain.

           Claim: ${f.file}:${f.line} — ${f.dimension}
           Spec says:   ${f.spec}
           Code says:   ${f.actual}

           Open both the handoff source and the code file and read them yourself.
           Refute if: the code value is actually correct, the cited handoff line does not say
           what the finding claims, or the value legitimately comes from a token/prop rather
           than being hardcoded.
           Set handoffInternalConflict if README and Vault.dc.html genuinely disagree here.`,
          { label: `refute:${f.file}:${f.line}`, phase: 'Verify', effort: 'high', schema: VERDICT },
        ).then((v) => ({ ...f, target, verdict: v })),
      ),
    )
  },
)

const all = perTarget.flat().filter(Boolean)
const confirmed = all.filter((f) => f.verdict && !f.verdict.refuted)
const conflicts = confirmed.filter((f) => f.verdict.handoffInternalConflict)

log(`${all.length} candidate findings → ${confirmed.length} survived refutation (${conflicts.length} are handoff conflicts)`)

if (!confirmed.length) {
  return { confirmed: [], conflicts: [], summary: 'No fidelity drift survived verification.' }
}

phase('Synthesize')
const report = await agent(
  `Write a fidelity report from these verified findings. Rank by severity, group by target.
   Call out separately any finding flagged handoffInternalConflict — those need a product
   decision, not a code fix. Be specific about file:line and the exact values. No preamble.

   ${JSON.stringify(confirmed, null, 2)}`,
  { label: 'synthesize', effort: 'high' },
)

return { confirmed, conflicts, report }
