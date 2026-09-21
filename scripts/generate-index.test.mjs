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
