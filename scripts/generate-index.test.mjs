import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { generatePluginIndex } from './generate-index.mjs'

// The host repo checkout name varies per machine; TWILIGHT_ECHO_ROOT matches
// the override used by scripts/pack-plugin.cjs.
const twilightRoot =
  process.env.TWILIGHT_ECHO_ROOT || resolve(import.meta.dirname, '..', '..', 'Twilight_Echo-main')
const { createZip } = await import(
  pathToFileURL(join(twilightRoot, 'packages', 'create-twilight-plugin', 'lib', 'zip.cjs')).href
)

const manifest = {
  id: 'com.example.generated',
  name: 'Generated Plugin',
  version: '1.2.3',
  description: 'A generated test plugin',
  author: 'Example',
  license: 'Apache-2.0',
  type: ['tool'],
  main: 'index.mjs',
  engines: {
    twilightEcho: '>=0.20.0'
  },
  apiVersion: 1,
  permissions: ['player:observe']
}

const themeManifest = {
  ...manifest,
  id: 'com.example.theme',
  type: ['theme'],
  main: undefined,
  apiVersion: 3,
  permissions: [],
  icon: 'icons/theme.svg',
  contributes: {
    themes: [{ id: 'example', name: 'Example', stylesheet: 'theme.css' }]
  }
}

test('packs and indexes declarative themes with their stylesheet and icon', async () => {
  const root = await createRepoFixture()
  const pluginDir = join(root, 'plugins', 'theme')
  await mkdir(join(root, 'scripts'))
  await mkdir(join(pluginDir, 'icons'), { recursive: true })
  await copyFile(
    new URL('./pack-plugin.cjs', import.meta.url),
    join(root, 'scripts', 'pack-plugin.cjs')
  )
  await writeFile(join(pluginDir, 'plugin.json'), JSON.stringify(themeManifest))
  await writeFile(join(pluginDir, 'README.md'), '# Theme')
  await writeFile(join(pluginDir, 'theme.css'), ':root { --accent: teal; }')
  await writeFile(
    join(pluginDir, 'icons', 'theme.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg"/>'
  )
  await promisify(execFile)(process.execPath, [
    join(root, 'scripts', 'pack-plugin.cjs'),
    'theme',
    '--twilight-root',
    twilightRoot
  ])
  const index = await generatePluginIndex({ repoRoot: root, write: true })
  assert.equal(index.plugins[0].id, themeManifest.id)
  assert.deepEqual(index.plugins[0].tags, ['theme'])
  const tar = process.platform === 'win32' ? 'C:/Windows/System32/tar.exe' : 'tar'
  const archive = join(root, 'packages', `${themeManifest.id}-${themeManifest.version}.tep`)
  for (const file of ['theme.css', 'icons/theme.svg']) {
    const { stdout } = await promisify(execFile)(tar, ['-xOf', archive, file])
    assert.equal(stdout, await readFile(join(pluginDir, file), 'utf8'))
  }
  await generatePluginIndex({ repoRoot: root, validateOnly: true })
})

test('rejects themes with executable entries or missing contributions and entryless tools', async () => {
  for (const invalid of [
    { ...themeManifest, main: 'index.mjs' },
    { ...themeManifest, binary: { 'win32-x64': 'plugin.dll' } },
    { ...themeManifest, contributes: { themes: [] } },
    { ...manifest, main: undefined }
  ]) {
    const root = await createRepoFixture()
    await createPluginPackage(root, invalid)
    await assert.rejects(() => generatePluginIndex({ repoRoot: root }), /main.*binary/)
  }
})

test('generates plugins.json from packaged tep files', async () => {
  const root = await createRepoFixture()
  const packagePath = await createPluginPackage(root, manifest)
  const checksumSha256 = createHash('sha256')
    .update(await readFile(packagePath))
    .digest('hex')

  const index = await generatePluginIndex({ repoRoot: root, write: true })
  const written = JSON.parse(await readFile(join(root, 'plugins.json'), 'utf-8'))

  assert.equal(index.schemaVersion, 1)
  assert.deepEqual(written, index)
  assert.equal(index.plugins.length, 1)
  assert.equal(index.plugins[0].id, manifest.id)
  assert.equal(index.plugins[0].sourceUrl, `packages/${manifest.id}-${manifest.version}.tep`)
  assert.equal(index.plugins[0].checksumSha256, checksumSha256)
  assert.equal(index.plugins[0].repository, undefined)
  assert.equal(index.plugins[0].homepage, undefined)
  assert.equal(index.plugins[0].verified, true)
})

test('preserves packaged metadata and rejects index-only metadata overrides', async () => {
  for (const metadata of [
    {},
    { repository: 'https://example.com/repo', homepage: 'https://example.com' }
  ]) {
    const root = await createRepoFixture()
    const packaged = { ...manifest, ...metadata }
    await createPluginPackage(root, packaged)
    const index = await generatePluginIndex({ repoRoot: root })
    for (const field of ['repository', 'homepage']) {
      assert.equal(index.plugins[0][field], packaged[field])
      assert.equal(Object.hasOwn(index.plugins[0], field), Object.hasOwn(packaged, field))
      await assert.rejects(
        () => generatePluginIndex({ repoRoot: root, [field]: 'https://different.example.com' }),
        /必须与安装包 manifest 一致/
      )
    }
  }
})

test('validate mode rejects a stale plugins.json', async () => {
  const root = await createRepoFixture()
  await createPluginPackage(root, manifest)
  await writeFile(
    join(root, 'plugins.json'),
    JSON.stringify({ schemaVersion: 1, plugins: [] }, null, 2),
    'utf-8'
  )

  await assert.rejects(
    () => generatePluginIndex({ repoRoot: root, validateOnly: true }),
    /plugins.json is out of date/
  )
})

test('keeps only the latest package for each plugin id', async () => {
  const root = await createRepoFixture()
  await createPluginPackage(root, { ...manifest, version: '1.0.0' })
  await createPluginPackage(root, { ...manifest, version: '1.2.3' })

  const index = await generatePluginIndex({ repoRoot: root })

  assert.equal(index.plugins.length, 1)
  assert.equal(index.plugins[0].version, '1.2.3')
  assert.equal(index.plugins[0].sourceUrl, `packages/${manifest.id}-1.2.3.tep`)
})

test('adds the QQ Music tag for QQ Music provider packages', async () => {
  const root = await createRepoFixture()
  await createPluginPackage(root, {
    ...manifest,
    id: 'com.example.qqmusic',
    name: 'QQ Music'
  })

  const index = await generatePluginIndex({ repoRoot: root })

  assert.deepEqual(index.plugins[0].tags, ['tool', 'qq-music'])
})

test('adds the KuGou tag for KuGou provider packages', async () => {
  const root = await createRepoFixture()
  await createPluginPackage(root, {
    ...manifest,
    id: 'com.example.kugou',
    name: 'KuGou Music'
  })

  const index = await generatePluginIndex({ repoRoot: root })

  assert.deepEqual(index.plugins[0].tags, ['tool', 'kugou'])
})

test('rejects packages without plugin README and bundled plugin ids', async () => {
  const missingReadmeRoot = await createRepoFixture()
  await createPluginPackage(missingReadmeRoot, manifest, { readme: false })
  await assert.rejects(() => generatePluginIndex({ repoRoot: missingReadmeRoot }), /README/)

  const bundledRoot = await createRepoFixture()
  await createPluginPackage(bundledRoot, {
    ...manifest,
    id: 'com.twilightecho.provider.ncm',
    name: 'NCM'
  })
  await assert.rejects(() => generatePluginIndex({ repoRoot: bundledRoot }), /内置/)
})

test('merges release packages from two independent publishers', async () => {
  const root = await createRepoFixture()
  await createPluginPackage(root, manifest)
  const alice = await createExternalSubmission(root, {
    ...manifest,
    id: 'com.alice.lyrics',
    name: 'Lyrics',
    author: 'Alice',
    repository: 'https://github.com/alice/lyrics'
  })
  const bob = await createExternalSubmission(root, {
    ...manifest,
    id: 'org.bob.radio',
    name: 'Radio',
    author: 'Bob',
    repository: 'https://github.com/bob/radio'
  })
  const fetchImpl = releaseFetch(new Map([[alice.url, alice.bytes], [bob.url, bob.bytes]]))
  const index = await generatePluginIndex({ repoRoot: root, fetchImpl, write: true })
  assert.equal(index.plugins.length, 3)
  assert.deepEqual(index.plugins.filter((entry) => entry.id !== manifest.id).map((entry) => entry.author), [
    'Alice',
    'Bob'
  ])
  await generatePluginIndex({ repoRoot: root, fetchImpl, validateOnly: true })
})

test('rejects duplicate external ids, checksum mismatch, manifest mismatch and unavailable assets', async () => {
  const root = await createRepoFixture()
  const externalManifest = { ...manifest, repository: 'https://github.com/alice/plugin' }
  const submission = await createExternalSubmission(root, externalManifest)
  await createPluginPackage(root, externalManifest)
  await assert.rejects(
    () => generatePluginIndex({ repoRoot: root, fetchImpl: releaseFetch(new Map([[submission.url, submission.bytes]])) }),
    /重复插件 id/
  )

  const secondRoot = await createRepoFixture()
  const second = await createExternalSubmission(secondRoot, externalManifest)
  const descriptorPath = join(secondRoot, 'catalog', `${externalManifest.id}.json`)
  const descriptor = JSON.parse(await readFile(descriptorPath, 'utf8'))
  descriptor.checksumSha256 = '0'.repeat(64)
  await writeFile(descriptorPath, JSON.stringify(descriptor))
  await assert.rejects(
    () => generatePluginIndex({ repoRoot: secondRoot, fetchImpl: releaseFetch(new Map([[second.url, second.bytes]])) }),
    /SHA-256 不匹配/
  )
  descriptor.checksumSha256 = createHash('sha256').update(second.bytes).digest('hex')
  descriptor.id = 'com.alice.different'
  await writeFile(descriptorPath, JSON.stringify(descriptor))
  await assert.rejects(
    () => generatePluginIndex({ repoRoot: secondRoot, fetchImpl: releaseFetch(new Map([[second.url, second.bytes]])) }),
    /文件名不匹配/
  )
  descriptor.id = externalManifest.id
  descriptor.version = '1.2.4'
  descriptor.sourceUrl = `${externalManifest.repository}/releases/download/v1.2.4/${externalManifest.id}-1.2.4.tep`
  await writeFile(descriptorPath, JSON.stringify(descriptor))
  await assert.rejects(
    () => generatePluginIndex({ repoRoot: secondRoot, fetchImpl: releaseFetch(new Map([[descriptor.sourceUrl, second.bytes]])) }),
    /收录记录与包内 manifest 不一致/
  )
  await assert.rejects(
    () => generatePluginIndex({ repoRoot: secondRoot, fetchImpl: releaseFetch(new Map()) }),
    /下载失败/
  )
})

test('rejects a version rollback and a change of publisher repository', async () => {
  const root = await createRepoFixture()
  const published = { ...manifest, repository: 'https://github.com/alice/plugin' }
  const submission = await createExternalSubmission(root, published)
  const baselineIndexPath = join(root, 'baseline.json')
  const baseline = {
    plugins: [{ id: published.id, version: '2.0.0', repository: published.repository }]
  }
  await writeFile(baselineIndexPath, JSON.stringify(baseline))
  await assert.rejects(
    () => generatePluginIndex({ repoRoot: root, baselineIndexPath, fetchImpl: releaseFetch(new Map([[submission.url, submission.bytes]])) }),
    /版本不能回退/
  )
  baseline.plugins[0].version = '1.0.0'
  baseline.plugins[0].repository = 'https://github.com/another/plugin'
  await writeFile(baselineIndexPath, JSON.stringify(baseline))
  await assert.rejects(
    () => generatePluginIndex({ repoRoot: root, baselineIndexPath, fetchImpl: releaseFetch(new Map([[submission.url, submission.bytes]])) }),
    /发布仓库不能/
  )
})

test('treats a prerelease as older than its stable version', async () => {
  const root = await createRepoFixture()
  const published = {
    ...manifest,
    version: '1.2.3-beta.2',
    repository: 'https://github.com/alice/plugin'
  }
  const submission = await createExternalSubmission(root, published)
  const baselineIndexPath = join(root, 'baseline.json')
  await writeFile(baselineIndexPath, JSON.stringify({
    plugins: [{ id: published.id, version: '1.2.3', repository: published.repository }]
  }))
  await assert.rejects(
    () => generatePluginIndex({
      repoRoot: root,
      baselineIndexPath,
      fetchImpl: releaseFetch(new Map([[submission.url, submission.bytes]]))
    }),
    /版本不能回退/
  )
})

test('rejects an oversized external release before reading its body', async () => {
  const root = await createRepoFixture()
  const submission = await createExternalSubmission(root, {
    ...manifest,
    repository: 'https://github.com/alice/plugin'
  })
  await assert.rejects(
    () => generatePluginIndex({
      repoRoot: root,
      fetchImpl: async () => new Response(submission.bytes, {
        headers: { 'content-length': String(50 * 1024 * 1024 + 1) }
      })
    }),
    /超过 50 MB/
  )
})

async function createRepoFixture() {
  const root = await mkdtemp(join(tmpdir(), 'twilight-plugin-index-generator-'))
  await mkdir(join(root, 'packages'), { recursive: true })
  await mkdir(join(root, 'plugins'), { recursive: true })
  return root
}

async function createPluginPackage(root, pluginManifest, options = {}) {
  const pluginName = pluginManifest.id.split('.').at(-1)
  const pluginDir = join(root, 'plugins', pluginName)
  const stagingDir = join(root, '.cache', pluginManifest.id)
  await mkdir(pluginDir, { recursive: true })
  await mkdir(stagingDir, { recursive: true })
  await writeFile(join(pluginDir, 'plugin.json'), JSON.stringify(pluginManifest, null, 2), 'utf-8')
  await writeFile(join(pluginDir, 'README.md'), '# Test plugin\n', 'utf-8')
  if (options.readme === false) {
    await writeFile(join(pluginDir, 'README.md'), '', 'utf-8')
  }
  await writeFile(join(stagingDir, 'plugin.json'), JSON.stringify(pluginManifest, null, 2), 'utf-8')
  await writeFile(join(stagingDir, 'index.mjs'), 'export function activate() {}', 'utf-8')
  const packagePath = resolve(
    root,
    'packages',
    `${pluginManifest.id}-${pluginManifest.version}.tep`
  )
  await createZip(stagingDir, packagePath)
  return packagePath
}

async function createExternalSubmission(root, pluginManifest) {
  const staging = join(root, '.cache', `external-${pluginManifest.id}`)
  await mkdir(staging, { recursive: true })
  await mkdir(join(root, 'catalog'), { recursive: true })
  await writeFile(join(staging, 'plugin.json'), JSON.stringify(pluginManifest))
  await writeFile(join(staging, 'index.mjs'), 'export function activate() {}')
  const packagePath = join(staging, `${pluginManifest.id}-${pluginManifest.version}.tep`)
  await createZip(staging, packagePath)
  const bytes = await readFile(packagePath)
  const url = `${pluginManifest.repository}/releases/download/v${pluginManifest.version}/${pluginManifest.id}-${pluginManifest.version}.tep`
  await writeFile(
    join(root, 'catalog', `${pluginManifest.id}.json`),
    JSON.stringify({
      id: pluginManifest.id,
      version: pluginManifest.version,
      repository: pluginManifest.repository,
      sourceUrl: url,
      checksumSha256: createHash('sha256').update(bytes).digest('hex'),
      tags: ['tool']
    })
  )
  return { url, bytes }
}

function releaseFetch(packages) {
  return async (url) => {
    const bytes = packages.get(url)
    return bytes ? new Response(bytes) : new Response('', { status: 404 })
  }
}
