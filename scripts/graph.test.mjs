import test from 'node:test'
import assert from 'node:assert/strict'
import { parseFrontmatter, findCycles, loadNodes, check } from './graph.mjs'

test('parseFrontmatter reads scalars and inline arrays', () => {
  const { data, body } = parseFrontmatter(
    `---\nid: screen-library\nkind: screen\ndepends_on: [contract-doc, comp-doc-card]\n---\nBody text here.\n`,
  )
  assert.equal(data.id, 'screen-library')
  assert.equal(data.kind, 'screen')
  assert.deepEqual(data.depends_on, ['contract-doc', 'comp-doc-card'])
  assert.equal(body, 'Body text here.')
})

test('parseFrontmatter handles an empty dependency list', () => {
  const { data } = parseFrontmatter(`---\nid: a\ndepends_on: []\n---\n`)
  assert.deepEqual(data.depends_on, [])
})

test('parseFrontmatter returns null data when there is no frontmatter', () => {
  const { data } = parseFrontmatter('just a document\n')
  assert.equal(data, null)
})

test('findCycles detects a dependency loop', () => {
  const cycles = findCycles([
    { id: 'a', depends_on: ['b'] },
    { id: 'b', depends_on: ['c'] },
    { id: 'c', depends_on: ['a'] },
  ])
  assert.equal(cycles.length, 1)
  assert.match(cycles[0], /a/)
})

test('findCycles accepts a valid DAG', () => {
  assert.deepEqual(
    findCycles([
      { id: 'a', depends_on: ['b', 'c'] },
      { id: 'b', depends_on: ['c'] },
      { id: 'c', depends_on: [] },
    ]),
    [],
  )
})

test('the committed context graph passes its own integrity check', async () => {
  const nodes = await loadNodes()
  assert.ok(nodes.length > 0, 'expected context-graph/nodes to contain nodes')
  const { errors } = await check(nodes)
  assert.deepEqual(errors, [], `context graph has integrity errors:\n${errors.join('\n')}`)
})
