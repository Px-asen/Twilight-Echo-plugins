import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, open, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { buildEdgeOneMirror } from './build-edgeone-mirror.mjs'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'edgeone-mirror-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'packages'))
  const bytes = Buffer.from('unchanged package bytes')
  const entry = {
    id: 'test.plugin',
    sourceUrl: 'packages/test.plugin-1.0.0.tep',
    checksumSha256: createHash('sha256').update(bytes).digest('hex'),
    signature: 'preserved metadata'
  }
  await writeFile(join(root, entry.sourceUrl), bytes)
  const saveIndex = (entries = [entry]) => writeFile(join(root, 'plugins.json'), JSON.stringify({ schemaVersion: 1, plugins: entries }))
  await saveIndex()
  return { root, bytes, entry, saveIndex }
}

test('publishes only referenced files, preserving bytes and external discovery entries', async t => {
  const { root, bytes, entry, saveIndex } = await fixture(t)
  await saveIndex([entry, { id: 'community.plugin', sourceUrl: 'https://example.com/release.tep' }])
  await mkdir(join(root, 'dist', 'scripts'), { recursive: true })
  await writeFile(join(root, 'dist', 'scripts', 'stale.js'), 'stale')
  await writeFile(join(root, 'packages', 'old.tep'), 'unreferenced')
  await buildEdgeOneMirror(root)
  assert.deepEqual((await readdir(join(root, 'dist'))).sort(), ['index.html', 'packages', 'plugins.json'])
  assert.deepEqual(await readdir(join(root, 'dist', 'packages')), ['test.plugin-1.0.0.tep'])
  assert.deepEqual(await readFile(join(root, 'dist', entry.sourceUrl)), bytes)
  assert.deepEqual(await readFile(join(root, 'dist', 'plugins.json')), await readFile(join(root, 'plugins.json')))
  assert.match(await readFile(join(root, 'dist', 'index.html'), 'utf8'), /href="\.\/plugins.json"/)
})

test('rejects missing index and missing referenced package', async t => {
  const { root, entry, saveIndex } = await fixture(t)
  await rm(join(root, 'plugins.json'))
  await assert.rejects(buildEdgeOneMirror(root), /Missing distribution file: plugins.json/)
  await saveIndex()
  await rm(join(root, entry.sourceUrl))
  await assert.rejects(buildEdgeOneMirror(root), /Missing distribution file: packages\/test.plugin/)
})

test('rejects oversized packages before reading their contents', async t => {
  const { root, entry } = await fixture(t)
  const file = await open(join(root, entry.sourceUrl), 'w')
  try { await file.truncate(25_000_001) } finally { await file.close() }
  await assert.rejects(buildEdgeOneMirror(root), /test.plugin.*25000001 bytes.*25 MB/)
})

test('rejects checksum mismatches and paths outside the distribution allowlist', async t => {
  const { root, entry, saveIndex } = await fixture(t)
  await saveIndex([{ ...entry, checksumSha256: '0'.repeat(64) }])
  await assert.rejects(buildEdgeOneMirror(root), /SHA-256 does not match/)
  for (const sourceUrl of ['packages/../private.tep', '../private.tep', 'scripts/private.tep']) {
    await saveIndex([{ ...entry, sourceUrl }])
    await assert.rejects(buildEdgeOneMirror(root), /unsupported local package URL/)
  }
})
