import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { buildR2, INDEX_CACHE_CONTROL, PACKAGE_CACHE_CONTROL } from './build-r2.mjs'
import { deployR2 } from './deploy-r2.mjs'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'r2-distribution-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'packages'))
  const bytes = Buffer.from('original public plugin archive')
  const entry = {
    id: 'com.test.plugin', version: '1.0.0', license: 'MIT', verified: false,
    sourceUrl: 'packages/com.test.plugin-1.0.0.tep',
    checksumSha256: createHash('sha256').update(bytes).digest('hex')
  }
  await writeFile(join(root, entry.sourceUrl), bytes)
  await writeFile(join(root, 'r2.json'), JSON.stringify({
    accountId: 'test', bucket: 'test-plugins', publicBaseUrl: 'https://plugins.example.com/',
    excludedPlugins: { 'com.test.private': 'Local preview only' }
  }))
  const save = entries => writeFile(join(root, 'plugins.json'), JSON.stringify({ schemaVersion: 1, plugins: entries }))
  await save([entry])
  return { root, bytes, entry, save }
}

test('copies exact bytes, mirrors external packages, preserves claims and omits restricted previews', async t => {
  const { root, bytes, entry, save } = await fixture(t)
  const external = { ...entry, id: 'com.test.external', sourceUrl: 'https://github.com/test/repo/releases/download/v1.0.0/external.tep' }
  await save([entry, external, { id: 'com.test.private' }])
  await writeFile(join(root, 'packages', 'unreferenced.tep'), 'do not publish')
  const { output, objects, excluded } = await buildR2({ root, fetchImpl: async url => {
    assert.equal(url, external.sourceUrl)
    return new Response(bytes)
  } })
  assert.equal(objects.length, 2)
  assert.equal(excluded.length, 1)
  assert.equal((await readdir(join(output, 'packages'))).length, 2)
  const built = JSON.parse(await readFile(join(output, 'plugins.json')))
  for (let i = 0; i < 2; i++) {
    assert.deepEqual(built.plugins[i], { ...[entry, external][i], sourceUrl: objects[i].key })
    assert.deepEqual(await readFile(join(output, objects[i].key)), bytes)
  }
  assert.equal(JSON.parse(await readFile(join(root, 'plugins.json'))).plugins.length, 3)
})

test('rejects corrupt bytes, signed entries and invalid paths without replacing a valid build', async t => {
  const { root, entry, save } = await fixture(t)
  const { output } = await buildR2({ root })
  const previous = await readFile(join(output, 'plugins.json'), 'utf8')
  for (const [changed, message] of [
    [{ checksumSha256: '0'.repeat(64) }, /SHA-256 mismatch/],
    [{ publisherSignature: { value: 'signed' } }, /re-sign/],
    [{ sourceUrl: 'packages/../private.tep' }, /unsupported sourceUrl/],
    [{ sourceUrl: 'http://example.com/private.tep' }, /unsupported sourceUrl/]
  ]) {
    await save([{ ...entry, ...changed }])
    await assert.rejects(buildR2({ root }), message)
    assert.equal(await readFile(join(output, 'plugins.json'), 'utf8'), previous)
  }
})

test('fails closed when external download fails or exceeds the package limit', async t => {
  const { root, entry, save } = await fixture(t)
  await save([{ ...entry, sourceUrl: 'https://example.com/plugin.tep' }])
  await assert.rejects(buildR2({ root, fetchImpl: async () => new Response('missing', { status: 404 }) }), /download failed/)
  await assert.rejects(buildR2({ root, fetchImpl: async () => new Response('large', { headers: { 'content-length': 50 * 1024 * 1024 + 1 } }) }), /exceeds 50 MiB/)
})

test('uploads immutable packages before index, setting content types and TTLs', async t => {
  const { root } = await fixture(t)
  const puts = []
  await deployR2({ root, client: { send: async command => {
    if (command.constructor.name === 'HeadObjectCommand') throw { $metadata: { httpStatusCode: 404 } }
    puts.push(command.input)
    return {}
  } } })
  assert.equal(puts.length, 2)
  assert.match(puts[0].Key, /^packages\/.+\.tep$/)
  assert.equal(puts[0].CacheControl, PACKAGE_CACHE_CONTROL)
  assert.equal(puts[0].ContentType, 'application/octet-stream')
  assert.equal(puts[0].IfNoneMatch, '*')
  assert.equal(puts[1].Key, 'plugins.json')
  assert.equal(puts[1].CacheControl, INDEX_CACHE_CONTROL)
  assert.match(puts[1].ContentType, /^application\/json/)
})

test('skips existing exact objects, refuses unexpected objects and never publishes after an upload failure', async t => {
  const { root, entry, bytes } = await fixture(t)
  let puts = []
  await deployR2({ root, client: { send: async command => {
    if (command.constructor.name === 'HeadObjectCommand') return { Metadata: { sha256: entry.checksumSha256 }, ContentLength: bytes.length }
    puts.push(command.input.Key)
  } } })
  assert.deepEqual(puts, ['plugins.json'])
  puts = []
  await assert.rejects(deployR2({ root, client: { send: async command => {
    if (command.constructor.name === 'HeadObjectCommand') return { Metadata: {}, ContentLength: bytes.length }
    puts.push(command.input.Key)
  } } }), /unexpected metadata/)
  assert.deepEqual(puts, [])
  await assert.rejects(deployR2({ root, client: { send: async command => {
    if (command.constructor.name === 'HeadObjectCommand') throw { $metadata: { httpStatusCode: 404 } }
    puts.push(command.input.Key)
    throw new Error('network unavailable')
  } } }), /network unavailable/)
  assert.equal(puts.length, 1)
  assert.notEqual(puts[0], 'plugins.json')
})
