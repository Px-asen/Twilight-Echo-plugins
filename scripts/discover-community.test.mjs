import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { discoverCommunityPlugins } from './discover-community.mjs'
import { generatePluginIndex } from './generate-index.mjs'

const twilightRoot = process.env.TWILIGHT_ECHO_ROOT || resolve(import.meta.dirname, '..', '..', 'Twilight_Echo-main')
const { createZip } = await import(pathToFileURL(join(twilightRoot, 'packages', 'create-twilight-plugin', 'lib', 'zip.cjs')).href)

test('discovers releases from two publishers and generates unverified searchable entries', async () => {
  const root = await fixture()
  const alice = await release(root, 'alice', 'lyrics', 'com.alice.lyrics', '1.0.0')
  const bob = await release(root, 'bob', 'radio', 'org.bob.radio', '2.0.0')
  const fetchImpl = githubFetch([alice, bob])
  const result = await discoverCommunityPlugins({ repoRoot: root, fetchImpl, write: true })
  assert.equal(result.scannedRepositories, 2)
  assert.deepEqual(result.community.plugins.map((plugin) => plugin.id), ['com.alice.lyrics', 'org.bob.radio'])
  assert.ok(result.index.plugins.every((plugin) => plugin.verified === false))
  assert.ok(result.index.plugins.every((plugin) => plugin.tags.includes('community')))
  assert.deepEqual(result.community.owners, {
    'com.alice.lyrics': alice.repository,
    'org.bob.radio': bob.repository
  })
  await generatePluginIndex({ repoRoot: root, fetchImpl, validateOnly: true })
})

test('quarantines duplicate plugin IDs from different new publishers', async () => {
  const root = await fixture()
  const alice = await release(root, 'alice', 'tool', 'com.example.tool', '1.0.0')
  const bob = await release(root, 'bob', 'tool', 'com.example.tool', '1.0.0')
  const result = await discoverCommunityPlugins({ repoRoot: root, fetchImpl: githubFetch([alice, bob]) })
  assert.deepEqual(result.community.plugins, [])
  assert.deepEqual(result.index.plugins, [])
})

test('keeps publisher ownership and rejects an asset replacement at the same version', async () => {
  const root = await fixture()
  const alice = await release(root, 'alice', 'tool', 'com.example.tool', '1.0.0')
  await discoverCommunityPlugins({ repoRoot: root, fetchImpl: githubFetch([alice]) })
  const changed = await release(root, 'alice', 'tool', 'com.example.tool', '1.0.0', 'changed bytes')
  const retained = await discoverCommunityPlugins({ repoRoot: root, fetchImpl: githubFetch([changed]) })
  assert.deepEqual(retained.community.plugins, [])
  assert.equal(retained.community.history['com.example.tool'].checksumSha256, alice.checksumSha256)

  const bob = await release(root, 'bob', 'tool', 'com.example.tool', '1.1.0')
  const stolen = await discoverCommunityPlugins({ repoRoot: root, fetchImpl: githubFetch([bob]) })
  assert.deepEqual(stolen.community.plugins, [])
  assert.equal(stolen.community.owners['com.example.tool'], alice.repository)
})

test('rejects a publisher release rollback and remembers the prior version', async () => {
  const root = await fixture()
  const current = await release(root, 'alice', 'tool', 'com.example.tool', '2.0.0')
  await discoverCommunityPlugins({ repoRoot: root, fetchImpl: githubFetch([current]) })
  const rollback = await release(root, 'alice', 'tool', 'com.example.tool', '1.0.0')
  const result = await discoverCommunityPlugins({ repoRoot: root, fetchImpl: githubFetch([rollback]) })
  assert.deepEqual(result.community.plugins, [])
  assert.deepEqual(result.index.plugins, [])
  assert.equal(result.community.history['com.example.tool'].version, '2.0.0')
})

test('remembers the highest version after a repository leaves and rejoins the topic', async () => {
  const root = await fixture()
  const current = await release(root, 'alice', 'tool', 'com.example.tool', '2.0.0')
  await discoverCommunityPlugins({ repoRoot: root, fetchImpl: githubFetch([current]) })
  await discoverCommunityPlugins({ repoRoot: root, fetchImpl: githubFetch([]) })
  const rollback = await release(root, 'alice', 'tool', 'com.example.tool', '1.0.0')
  const result = await discoverCommunityPlugins({ repoRoot: root, fetchImpl: githubFetch([rollback]) })
  assert.deepEqual(result.index.plugins, [])
  assert.equal(result.community.history['com.example.tool'].version, '2.0.0')
})

test('gives a reviewed catalog entry precedence over automatic discovery', async () => {
  const root = await fixture()
  const published = await release(root, 'alice', 'tool', 'com.example.tool', '1.0.0')
  await writeFile(join(root, 'catalog', 'com.example.tool.json'), JSON.stringify({
    id: 'com.example.tool',
    version: '1.0.0',
    repository: published.repository,
    sourceUrl: published.sourceUrl,
    checksumSha256: published.checksumSha256,
    tags: ['reviewed']
  }))
  const result = await discoverCommunityPlugins({ repoRoot: root, fetchImpl: githubFetch([published]) })
  assert.deepEqual(result.community.plugins, [])
  assert.equal(result.index.plugins[0].verified, true)
  assert.deepEqual(result.index.plugins[0].tags, ['reviewed'])
})

test('skips a package whose manifest path escapes the plugin root', async () => {
  const root = await fixture()
  const invalid = await release(root, 'alice', 'tool', 'com.example.tool', '1.0.0',
    'export function activate() {}', { main: '../index.mjs' })
  const result = await discoverCommunityPlugins({ repoRoot: root, fetchImpl: githubFetch([invalid]) })
  assert.deepEqual(result.index.plugins, [])
})

test('does not rewrite the market when GitHub search fails', async () => {
  const root = await fixture()
  const originalIndex = await readFile(join(root, 'plugins.json'), 'utf8')
  await assert.rejects(
    () => discoverCommunityPlugins({ repoRoot: root, fetchImpl: async () => new Response('', { status: 503 }) }),
    /GitHub API 请求失败/
  )
  assert.equal(await readFile(join(root, 'plugins.json'), 'utf8'), originalIndex)
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'twilight-community-discovery-'))
  await mkdir(join(root, 'packages'))
  await mkdir(join(root, 'plugins'))
  await mkdir(join(root, 'catalog'))
  await writeFile(join(root, 'plugins.json'), '{\n  "schemaVersion": 1,\n  "plugins": []\n}\n')
  await writeFile(join(root, 'community.json'), '{\n  "schemaVersion": 1,\n  "owners": {},\n  "plugins": []\n}\n')
  return root
}

async function release(root, owner, repo, id, version, code = 'export function activate() {}', overrides = {}) {
  const repository = `https://github.com/${owner}/${repo}`
  const staging = await mkdtemp(join(root, 'staging-'))
  await writeFile(join(staging, 'plugin.json'), JSON.stringify({
    id,
    name: `${owner} plugin`,
    version,
    description: 'Community plugin',
    author: owner,
    license: 'MIT',
    type: ['tool'],
    main: 'index.mjs',
    engines: { twilightEcho: '>=0.20.0' },
    apiVersion: 1,
    permissions: [],
    repository,
    ...overrides
  }))
  await writeFile(join(staging, 'index.mjs'), code)
  const name = `${id}-${version}.tep`
  const packagePath = join(root, `${owner}-${name}`)
  await createZip(staging, packagePath)
  const bytes = await readFile(packagePath)
  const sourceUrl = `${repository}/releases/download/v${version}/${name}`
  return { owner, repo, repository, name, sourceUrl, bytes, checksumSha256: await sha256(bytes) }
}

async function sha256(bytes) {
  const { createHash } = await import('node:crypto')
  return createHash('sha256').update(bytes).digest('hex')
}

function githubFetch(releases) {
  const byUrl = new Map(releases.map((item) => [item.sourceUrl, item]))
  return async (url) => {
    const requested = String(url)
    if (requested.startsWith('https://api.github.com/search/repositories')) {
      return Response.json({
        total_count: releases.length,
        incomplete_results: false,
        items: releases.map((item) => ({
          full_name: `${item.owner}/${item.repo}`,
          topics: ['twilight-echo-plugin', 'music'],
          private: false,
          archived: false,
          fork: false
        }))
      })
    }
    for (const item of releases) {
      if (requested === `https://api.github.com/repos/${item.owner}/${item.repo}/releases/latest`) {
        return Response.json({ assets: [{ name: item.name, browser_download_url: item.sourceUrl, size: item.bytes.length }] })
      }
    }
    const item = byUrl.get(requested)
    return item ? new Response(item.bytes) : new Response('', { status: 404 })
  }
}
