#!/usr/bin/env node
// Context graph over context-graph/nodes/*.md.
// Edges point toward what you must understand FIRST — `a depends_on b` means read b before a.
//
//   node scripts/graph.mjs                          build graph.json
//   node scripts/graph.mjs --check                  integrity gate (part of `npm run verify`)
//   node scripts/graph.mjs --subgraph <id> [--depth N]   what to read before touching <id>
//   node scripts/graph.mjs --impact <id>            what breaks if <id> changes
//   node scripts/graph.mjs --status                 counts by status and owner
//   node scripts/graph.mjs --mermaid                write context-graph/graph.mmd

import { readdir, readFile, writeFile, access } from 'node:fs/promises'
import { join, dirname, resolve, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const NODES_DIR = join(ROOT, 'context-graph', 'nodes')

const KINDS = ['screen', 'component', 'contract', 'service', 'token', 'decision', 'risk', 'milestone']
const STATUSES = ['planned', 'in-progress', 'done', 'blocked']

/** Minimal frontmatter parser: `key: value` and `key: [a, b]`. Deliberately not a YAML engine. */
export function parseFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text)
  if (!match) return { data: null, body: text }
  const data = {}
  for (const raw of match[1].split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const sep = line.indexOf(':')
    if (sep === -1) continue
    const key = line.slice(0, sep).trim()
    let value = line.slice(sep + 1).trim()
    if (value.startsWith('[') && value.endsWith(']')) {
      value = value
        .slice(1, -1)
        .split(',')
        .map((s) => s.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean)
    } else {
      value = value.replace(/^["']|["']$/g, '')
    }
    data[key] = value
  }
  return { data, body: match[2].trim() }
}

export async function loadNodes(dir = NODES_DIR) {
  let files
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith('.md') && f !== 'README.md')
  } catch {
    return []
  }
  const nodes = []
  for (const file of files) {
    const text = await readFile(join(dir, file), 'utf8')
    const { data, body } = parseFrontmatter(text)
    if (!data) continue
    nodes.push({
      ...data,
      depends_on: Array.isArray(data.depends_on) ? data.depends_on : data.depends_on ? [data.depends_on] : [],
      summary: body.split(/\r?\n\r?\n/)[0] ?? '',
      file: join('context-graph/nodes', file),
      stem: basename(file, '.md'),
    })
  }
  return nodes.sort((a, b) => String(a.id).localeCompare(String(b.id)))
}

export function findCycles(nodes) {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const cycles = []
  const state = new Map() // id -> 1 visiting, 2 done

  const walk = (id, path) => {
    if (state.get(id) === 2) return
    if (state.get(id) === 1) {
      cycles.push([...path.slice(path.indexOf(id)), id].join(' → '))
      return
    }
    state.set(id, 1)
    for (const dep of byId.get(id)?.depends_on ?? []) {
      if (byId.has(dep)) walk(dep, [...path, id])
    }
    state.set(id, 2)
  }

  for (const n of nodes) walk(n.id, [])
  return [...new Set(cycles)]
}

export async function check(nodes) {
  const errors = []
  const warnings = []
  const ids = new Set()

  for (const n of nodes) {
    const where = n.file
    if (!n.id) { errors.push(`${where}: missing 'id'`); continue }
    if (n.id !== n.stem) errors.push(`${where}: id '${n.id}' does not match filename stem '${n.stem}'`)
    if (ids.has(n.id)) errors.push(`${where}: duplicate id '${n.id}'`)
    ids.add(n.id)
    if (!n.title) errors.push(`${where}: missing 'title'`)
    if (!KINDS.includes(n.kind)) errors.push(`${where}: kind '${n.kind}' not one of ${KINDS.join('|')}`)
    if (!STATUSES.includes(n.status)) errors.push(`${where}: status '${n.status}' not one of ${STATUSES.join('|')}`)
    if (!n.owner) errors.push(`${where}: missing 'owner'`)
  }

  for (const n of nodes) {
    for (const dep of n.depends_on) {
      if (!ids.has(dep)) errors.push(`${n.file}: depends_on '${dep}' — no such node`)
      if (dep === n.id) errors.push(`${n.file}: depends on itself`)
    }
    if (n.spec) {
      const path = String(n.spec).split(':')[0]
      try {
        await access(join(ROOT, path))
      } catch {
        errors.push(`${n.file}: spec target '${path}' does not exist`)
      }
    } else {
      warnings.push(`${n.file}: no 'spec' — nothing to read for this node`)
    }
  }

  const referenced = new Set(nodes.flatMap((n) => n.depends_on))
  for (const n of nodes) {
    if (!n.depends_on.length && !referenced.has(n.id)) {
      warnings.push(`${n.file}: orphan — no inbound or outbound edges`)
    }
  }

  for (const c of findCycles(nodes)) errors.push(`cycle: ${c}`)

  return { errors, warnings }
}

function subgraph(nodes, rootId, depth) {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  if (!byId.has(rootId)) return null
  const seen = new Map([[rootId, 0]])
  const queue = [[rootId, 0]]
  while (queue.length) {
    const [id, d] = queue.shift()
    if (d >= depth) continue
    for (const dep of byId.get(id)?.depends_on ?? []) {
      if (!byId.has(dep) || seen.has(dep)) continue
      seen.set(dep, d + 1)
      queue.push([dep, d + 1])
    }
  }
  return [...seen.entries()].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0])).map(([id, d]) => ({ ...byId.get(id), depth: d }))
}

function impact(nodes, targetId) {
  const dependents = new Map()
  for (const n of nodes) for (const dep of n.depends_on) {
    if (!dependents.has(dep)) dependents.set(dep, [])
    dependents.get(dep).push(n.id)
  }
  const out = new Set()
  const queue = [targetId]
  while (queue.length) {
    for (const id of dependents.get(queue.shift()) ?? []) {
      if (out.has(id)) continue
      out.add(id)
      queue.push(id)
    }
  }
  return nodes.filter((n) => out.has(n.id))
}

function toMermaid(nodes) {
  const shape = { screen: '([%s])', component: '[%s]', contract: '{{%s}}', service: '[[%s]]', decision: '>%s]', risk: '{%s}', milestone: '(%s)', token: '[/%s/]' }
  const lines = ['graph RL']
  for (const n of nodes) {
    const tpl = shape[n.kind] ?? '[%s]'
    lines.push(`  ${n.id}${tpl.replace('%s', `"${n.title}"`)}`)
  }
  for (const n of nodes) for (const dep of n.depends_on) lines.push(`  ${n.id} --> ${dep}`)
  for (const n of nodes) if (n.status === 'done') lines.push(`  style ${n.id} stroke-width:2px`)
  return lines.join('\n')
}

function arg(flag) {
  const i = process.argv.indexOf(flag)
  return i === -1 ? null : (process.argv[i + 1] ?? '')
}

async function main() {
  const nodes = await loadNodes()
  if (!nodes.length) {
    console.error('No nodes found in context-graph/nodes/')
    process.exit(1)
  }

  if (process.argv.includes('--check')) {
    const { errors, warnings } = await check(nodes)
    for (const w of warnings) console.warn(`warn  ${w}`)
    for (const e of errors) console.error(`ERROR ${e}`)
    if (errors.length) {
      console.error(`\n${errors.length} error(s). Fix the nodes or run /graph-sync.`)
      process.exit(1)
    }
    console.log(`ok — ${nodes.length} nodes, ${nodes.reduce((n, x) => n + x.depends_on.length, 0)} edges, ${warnings.length} warning(s)`)
    return
  }

  const root = arg('--subgraph')
  if (root !== null) {
    const depth = Number(arg('--depth') ?? 2) || 2
    const sub = subgraph(nodes, root, depth)
    if (!sub) {
      console.error(`No node '${root}'. Available:\n  ${nodes.map((n) => n.id).join('\n  ')}`)
      process.exit(1)
    }
    console.log(`Context for '${root}' (depth ${depth}) — read these, in this order:\n`)
    for (const n of [...sub].reverse()) {
      console.log(`${'  '.repeat(n.depth)}${n.id}  [${n.kind}/${n.status}, ${n.owner}]`)
      console.log(`${'  '.repeat(n.depth)}  spec: ${n.spec ?? '(none)'}`)
      if (n.summary) console.log(`${'  '.repeat(n.depth)}  ${n.summary.replace(/\s+/g, ' ').slice(0, 160)}`)
    }
    const blocked = sub.filter((n) => n.id !== root && (n.status === 'blocked' || n.status === 'planned'))
    if (blocked.length) console.log(`\nNot ready yet: ${blocked.map((n) => `${n.id}(${n.status})`).join(', ')}`)
    return
  }

  const target = arg('--impact')
  if (target !== null) {
    const affected = impact(nodes, target)
    console.log(`Changing '${target}' affects ${affected.length} node(s):\n`)
    for (const n of affected) console.log(`  ${n.id}  [${n.kind}/${n.status}, ${n.owner}]  ${n.spec ?? ''}`)
    if (!affected.length) console.log('  (nothing depends on this yet)')
    return
  }

  if (process.argv.includes('--status')) {
    const tally = (key) => nodes.reduce((m, n) => m.set(n[key], (m.get(n[key]) ?? 0) + 1), new Map())
    for (const [label, m] of [['status', tally('status')], ['kind', tally('kind')], ['owner', tally('owner')]]) {
      console.log(`${label}: ${[...m].map(([k, v]) => `${k}=${v}`).join('  ')}`)
    }
    const blocked = nodes.filter((n) => n.status === 'blocked')
    if (blocked.length) console.log(`\nblocked:\n${blocked.map((n) => `  ${n.id} — ${n.summary.slice(0, 100)}`).join('\n')}`)
    return
  }

  if (process.argv.includes('--mermaid')) {
    const out = join(ROOT, 'context-graph', 'graph.mmd')
    await writeFile(out, toMermaid(nodes) + '\n')
    console.log(`wrote ${out}`)
    return
  }

  const out = join(ROOT, 'context-graph', 'graph.json')
  await writeFile(out, JSON.stringify({ generatedFrom: 'context-graph/nodes', nodes }, null, 2) + '\n')
  console.log(`wrote ${out} — ${nodes.length} nodes`)
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
