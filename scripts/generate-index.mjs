import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, isAbsolute, join, posix, resolve, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const INDEX_SCHEMA_VERSION = 1
const BUNDLED_PLUGIN_IDS = new Set(['com.twilightecho.provider.ncm'])
const MAX_PACKAGE_BYTES = 50 * 1024 * 1024
const RELEASE_URL = /^https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)\/releases\/download\/([^/?#]+)\/([^/?#]+\.tep)$/
const SHA256 = /^[a-f0-9]{64}$/i
const PLUGIN_TYPES = new Set(['provider', 'tool', 'ui', 'theme', 'dsp'])
const PLUGIN_PERMISSIONS = new Set([
  'network', 'filesystem:read', 'filesystem:write', 'player:control', 'player:observe',
  'library:read', 'library:write', 'settings', 'clipboard', 'ui:inject', 'dsp:native'
])
const REQUIRED_FIELDS = [
  'id',
  'name',
  'version',
  'description',
  'author',
  'license',
  'type',
  'engines',
  'apiVersion',
  'permissions'
]

export async function generatePluginIndex(options = {}) {
  const repoRoot = resolve(options.repoRoot ?? resolve(import.meta.dirname, '..'))
  const packagesDir = join(repoRoot, 'packages')
  const catalogDir = join(repoRoot, 'catalog')
  const communityPath = join(repoRoot, 'community.json')
  const entries = []

  await mkdir(packagesDir, { recursive: true })
  const packageNames = (await readdir(packagesDir))
    .filter((name) => name.toLowerCase().endsWith('.tep'))
    .sort((left, right) => left.localeCompare(right))

  const latestById = new Map()
  for (const packageName of packageNames) {
    const packagePath = join(packagesDir, packageName)
    const manifest = await readPackageManifest(packagePath)
    validateManifest(manifest, packageName)
    if (BUNDLED_PLUGIN_IDS.has(manifest.id)) {
      throw new Error(`插件索引不能包含 Twilight Echo 内置插件：${manifest.id}`)
    }
    await assertPluginReadme(repoRoot, manifest)
    const existing = latestById.get(manifest.id)
    if (existing && compareSemver(existing.manifest.version, manifest.version) >= 0) continue
    latestById.set(manifest.id, { packageName, packagePath, manifest })
  }

  const seenIds = new Set()
  for (const { packageName, packagePath, manifest } of latestById.values()) {
    if (seenIds.has(manifest.id)) throw new Error(`插件索引存在重复插件 id：${manifest.id}`)
    seenIds.add(manifest.id)
    const buffer = await readFile(packagePath)
    for (const field of ['repository', 'homepage']) {
      if (options[field] !== undefined && options[field] !== manifest[field]) {
        throw new Error(`${manifest.id} ${field} 必须与安装包 manifest 一致，请修改源码并重新打包`)
      }
    }
    entries.push({
      ...manifest,
      sourceUrl: packageSourceUrl(packageName, options.baseUrl),
      checksumSha256: createHash('sha256').update(buffer).digest('hex'),
      tags: inferTags(manifest),
      verified: true
    })
  }

  for (const entry of await readExternalEntries(catalogDir, options.fetchImpl ?? fetch)) {
    if (seenIds.has(entry.id)) throw new Error(`插件索引存在重复插件 id：${entry.id}`)
    seenIds.add(entry.id)
    entries.push(entry)
  }

  const communityEntries = options.communityEntries ?? await readCommunityEntries(communityPath, options.fetchImpl ?? fetch, seenIds)
  for (const entry of communityEntries) {
    if (seenIds.has(entry.id)) continue
    seenIds.add(entry.id)
    entries.push(entry)
  }

  entries.sort((left, right) => left.id.localeCompare(right.id))
  if (options.baselineIndexPath) {
    const baseline = JSON.parse(await readFile(options.baselineIndexPath, 'utf8'))
    for (const previous of baseline.plugins) {
      const current = entries.find((entry) => entry.id === previous.id)
      if (!current) continue
      if (compareSemver(current.version, previous.version) < 0) {
        throw new Error(`${previous.id} 版本不能回退`)
      }
      if (current.repository !== previous.repository) {
        throw new Error(`${previous.id} 发布仓库不能在普通更新中变更`)
      }
    }
  }
  const index = {
    schemaVersion: INDEX_SCHEMA_VERSION,
    plugins: entries
  }

  const indexPath = join(repoRoot, 'plugins.json')
  const serialized = `${JSON.stringify(index, null, 2)}\n`
  if (options.validateOnly) {
    const existing = await readFile(indexPath, 'utf-8')
    if (existing !== serialized) {
      throw new Error('plugins.json is out of date; run pnpm run index')
    }
  }
  if (options.write) await writeFile(indexPath, serialized, 'utf-8')
  return index
}

async function readExternalEntries(catalogDir, fetchImpl) {
  if (!existsSync(catalogDir)) return []
  const names = (await readdir(catalogDir)).filter((name) => name.endsWith('.json')).sort()
  const entries = []
  for (const name of names) {
    const descriptor = JSON.parse(await readFile(join(catalogDir, name), 'utf8'))
    const { id } = descriptor
    if (typeof id !== 'string' || name !== `${id}.json`) throw new Error(`${name} 的插件 ID 与文件名不匹配`)
    entries.push(await validateExternalDescriptor(descriptor, fetchImpl, true))
  }
  return entries
}

async function readCommunityEntries(path, fetchImpl, curatedIds) {
  if (!existsSync(path)) return []
  const community = JSON.parse(await readFile(path, 'utf8'))
  if (community.schemaVersion !== 1 || !Array.isArray(community.plugins)) {
    throw new Error('community.json 格式无效')
  }
  const entries = []
  const seenCommunityIds = new Set()
  for (const descriptor of community.plugins) {
    if (seenCommunityIds.has(descriptor.id)) {
      throw new Error(`社区索引存在重复插件 id：${descriptor.id}`)
    }
    seenCommunityIds.add(descriptor.id)
    if (curatedIds.has(descriptor.id)) continue
    entries.push(await validateExternalDescriptor(descriptor, fetchImpl, false))
  }
  return entries
}

async function validateExternalDescriptor(descriptor, fetchImpl, verified) {
  const { id, version, repository, sourceUrl, checksumSha256, tags } = descriptor
  if (BUNDLED_PLUGIN_IDS.has(id)) throw new Error(`插件索引不能包含 Twilight Echo 内置插件：${id}`)
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`${id} version 无效`)
  }
  const match = typeof sourceUrl === 'string' ? RELEASE_URL.exec(sourceUrl) : null
  if (!match || ![version, `v${version}`].includes(match[3]) || match[4] !== `${id}-${version}.tep`) {
    throw new Error(`${id} 必须使用匹配版本的 GitHub Release .tep 地址`)
  }
  const expectedRepository = `https://github.com/${match[1]}/${match[2]}`
  if (repository !== expectedRepository) throw new Error(`${id} 发布仓库与下载地址不一致`)
  if (typeof checksumSha256 !== 'string' || !SHA256.test(checksumSha256)) throw new Error(`${id} SHA-256 无效`)
  if (!Array.isArray(tags) || tags.some((tag) => typeof tag !== 'string' || !tag.trim())) {
    throw new Error(`${id} tags 无效`)
  }
  const packageBuffer = await downloadPackage(sourceUrl, fetchImpl)
  const actualChecksum = createHash('sha256').update(packageBuffer).digest('hex')
  if (actualChecksum !== checksumSha256.toLowerCase()) throw new Error(`${id} SHA-256 不匹配`)
  const manifest = await readPackageManifestFromBuffer(packageBuffer, `${id}-${version}.tep`)
  if (manifest.id !== id || manifest.version !== version || manifest.repository !== repository) {
    throw new Error(`${id} 收录记录与包内 manifest 不一致`)
  }
  validateManifest(manifest, `${id}-${version}.tep`)
  return {
    ...manifest,
    sourceUrl,
    checksumSha256: actualChecksum,
    tags: [...new Set(tags.map((tag) => tag.trim()))],
    verified
  }
}

export async function inspectCommunityAsset({ repository, sourceUrl, tags }, fetchImpl = fetch) {
  const match = RELEASE_URL.exec(sourceUrl)
  if (!match || repository !== `https://github.com/${match[1]}/${match[2]}`) {
    throw new Error('社区插件下载地址与仓库不一致')
  }
  const packageBuffer = await downloadPackage(sourceUrl, fetchImpl)
  const manifest = await readPackageManifestFromBuffer(packageBuffer, match[4])
  validateManifest(manifest, match[4])
  if (manifest.repository !== repository ||
      ![manifest.version, `v${manifest.version}`].includes(match[3])) {
    throw new Error(`${manifest.id} 包内 manifest 与 Release 不一致`)
  }
  const checksumSha256 = createHash('sha256').update(packageBuffer).digest('hex')
  const descriptor = {
    id: manifest.id,
    version: manifest.version,
    repository,
    sourceUrl,
    checksumSha256,
    tags: [...new Set([...manifest.type, ...tags, 'community'])]
  }
  return { descriptor, entry: { ...manifest, ...descriptor, verified: false } }
}

async function readPackageManifestFromBuffer(buffer, packageName) {
  const temporaryDir = await mkdtemp(join(tmpdir(), 'twilight-catalog-'))
  try {
    const packagePath = join(temporaryDir, packageName)
    await writeFile(packagePath, buffer)
    return await readPackageManifest(packagePath)
  } finally {
    await rm(temporaryDir, { recursive: true, force: true })
  }
}

async function downloadPackage(url, fetchImpl) {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(30_000) })
  if (!response.ok || !response.body) throw new Error(`插件包下载失败：${response.status}`)
  const declaredLength = Number(response.headers.get('content-length'))
  if (declaredLength > MAX_PACKAGE_BYTES) throw new Error('插件包超过 50 MB 上限')
  const chunks = []
  let size = 0
  for await (const chunk of response.body) {
    size += chunk.byteLength
    if (size > MAX_PACKAGE_BYTES) {
      throw new Error('插件包超过 50 MB 上限')
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, size)
}

async function readPackageManifest(packagePath) {
  const executable = process.platform === 'linux'
    ? 'unzip'
    : process.platform === 'win32' && existsSync('C:\\Windows\\System32\\tar.exe')
      ? 'C:\\Windows\\System32\\tar.exe'
      : 'tar'
  const args = process.platform === 'linux'
    ? ['-p', packagePath, 'plugin.json']
    : ['-xOf', packagePath, 'plugin.json']
  const { stdout } = await execFileAsync(executable, args, {
    maxBuffer: 1024 * 1024
  })
  return JSON.parse(stdout)
}

function validateManifest(manifest, packageName) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error(`${packageName} 缺少有效 plugin.json`)
  }
  for (const field of REQUIRED_FIELDS) {
    if (!(field in manifest))
      throw new Error(`${manifest.id ?? packageName} 缺少 manifest 字段：${field}`)
  }
  for (const field of ['name', 'description', 'author', 'license']) {
    if (typeof manifest[field] !== 'string' || !manifest[field].trim()) {
      throw new Error(`${manifest.id} ${field} 无效`)
    }
  }
  if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)+$/.test(manifest.id) ||
      !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(manifest.version)) {
    throw new Error(`${packageName} 插件 ID 或版本无效`)
  }
  if (!Array.isArray(manifest.type) || manifest.type.length === 0 ||
      manifest.type.some((type) => !PLUGIN_TYPES.has(type))) {
    throw new Error(`${manifest.id} type 无效`)
  }
  if (typeof manifest.engines?.twilightEcho !== 'string' ||
      !/^(\*|(?:\^|~|>=)?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/.test(manifest.engines.twilightEcho)) {
    throw new Error(`${manifest.id} engines.twilightEcho 兼容范围无效`)
  }
  if (!Number.isInteger(manifest.apiVersion) || manifest.apiVersion < 1 || manifest.apiVersion > 3) {
    throw new Error(`${manifest.id} apiVersion 不受支持`)
  }
  const isPureTheme =
    Array.isArray(manifest.type) && manifest.type.length === 1 && manifest.type[0] === 'theme'
  const hasThemes =
    Array.isArray(manifest.contributes?.themes) && manifest.contributes.themes.length > 0
  if (isPureTheme && (manifest.main || manifest.binary)) {
    throw new Error(`${manifest.id} 纯主题不能声明 main 或 binary`)
  }
  if (!manifest.main && !manifest.binary && !(isPureTheme && hasThemes)) {
    throw new Error(`${manifest.id} 必须声明 main 或 binary，或为纯主题声明 contributes.themes`)
  }
  for (const field of ['main', 'icon']) validateRelativePath(manifest[field], field, manifest.id)
  if (manifest.binary !== undefined) {
    if (!manifest.binary || typeof manifest.binary !== 'object' || Array.isArray(manifest.binary)) {
      throw new Error(`${manifest.id} binary 无效`)
    }
    if (Object.keys(manifest.binary).length === 0) throw new Error(`${manifest.id} binary 无效`)
    for (const [platform, path] of Object.entries(manifest.binary)) {
      validateRelativePath(path, `binary.${platform}`, manifest.id)
    }
  }
  if (manifest.dependencies !== undefined) {
    if (!manifest.dependencies || typeof manifest.dependencies !== 'object' || Array.isArray(manifest.dependencies)) {
      throw new Error(`${manifest.id} dependencies 无效`)
    }
    for (const [id, range] of Object.entries(manifest.dependencies)) {
      if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)+$/.test(id) || typeof range !== 'string' ||
          !/^(\*|(?:\^|~|>=)?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/.test(range.trim())) {
        throw new Error(`${manifest.id} dependencies 无效`)
      }
    }
  }
  if (manifest.type.includes('theme') && Array.isArray(manifest.contributes?.themes)) {
    for (const theme of manifest.contributes.themes) {
      if (!theme || typeof theme !== 'object' || Array.isArray(theme) ||
          typeof theme.id !== 'string' || !theme.id.trim() ||
          typeof theme.name !== 'string' || !theme.name.trim()) {
        throw new Error(`${manifest.id} contributes.themes 无效`)
      }
      validateRelativePath(theme.stylesheet, 'contributes.themes.stylesheet', manifest.id)
    }
  }
  if (manifest.type?.includes('dsp') && !manifest.binary) {
    throw new Error(`${manifest.id} 是 DSP 插件但缺少 binary`)
  }
  if (!Array.isArray(manifest.permissions)) {
    throw new Error(`${manifest.id} permissions 必须是数组`)
  }
  if (manifest.permissions.some((permission) => !PLUGIN_PERMISSIONS.has(permission))) {
    throw new Error(`${manifest.id} permissions 包含未知权限`)
  }
  if (manifest.type.includes('dsp') && !manifest.permissions.includes('dsp:native')) {
    throw new Error(`${manifest.id} DSP 插件缺少 dsp:native 权限`)
  }
  const expectedPackageName = `${manifest.id}-${manifest.version}.tep`
  if (basename(packageName) !== expectedPackageName) {
    throw new Error(`${manifest.id} 包名必须是 ${expectedPackageName}`)
  }
}

function validateRelativePath(value, field, id) {
  if (value === undefined || value === null) return
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) {
    throw new Error(`${id} ${field} 路径无效`)
  }
  const slashPath = value.trim().replace(/\\/g, '/')
  const normalized = posix.normalize(slashPath)
  if (isAbsolute(slashPath) || win32.isAbsolute(value) || /^[A-Za-z]:/.test(value) ||
      normalized === '.' || normalized === '..' || normalized.startsWith('../') ||
      normalized.endsWith('/')) {
    throw new Error(`${id} ${field} 路径超出插件目录`)
  }
}

async function assertPluginReadme(repoRoot, manifest) {
  const pluginsRoot = join(repoRoot, 'plugins')
  const names = await readdir(pluginsRoot).catch(() => [])
  for (const name of names) {
    const manifestPath = join(pluginsRoot, name, 'plugin.json')
    if (!existsSync(manifestPath)) continue
    const pluginManifest = JSON.parse(await readFile(manifestPath, 'utf-8'))
    if (pluginManifest.id !== manifest.id) continue
    const readmePath = join(pluginsRoot, name, 'README.md')
    const readme = existsSync(readmePath) ? await readFile(readmePath, 'utf-8') : ''
    if (!readme.trim()) throw new Error(`${manifest.id} 缺少 README.md`)
    return
  }
  throw new Error(`${manifest.id} 缺少 plugins/<name>/plugin.json 与 README.md`)
}

function packageSourceUrl(packageName, baseUrl) {
  if (!baseUrl) return `packages/${packageName}`
  return `${String(baseUrl).replace(/\/$/, '')}/${packageName}`
}

function inferTags(manifest) {
  const tags = new Set(Array.isArray(manifest.type) ? manifest.type : [])
  const id = String(manifest.id ?? '').toLowerCase()
  if (id.includes('bilibili')) tags.add('bilibili')
  if (id.includes('ytmusic') || id.includes('youtube')) tags.add('youtube-music')
  if (id.includes('qqmusic') || id.includes('qq-music')) tags.add('qq-music')
  if (id.includes('kugou')) tags.add('kugou')
  return [...tags]
}

export function compareSemver(left, right) {
  const leftVersion = String(left).split('+')[0]
  const rightVersion = String(right).split('+')[0]
  const leftDash = leftVersion.indexOf('-')
  const rightDash = rightVersion.indexOf('-')
  const leftCore = leftDash < 0 ? leftVersion : leftVersion.slice(0, leftDash)
  const rightCore = rightDash < 0 ? rightVersion : rightVersion.slice(0, rightDash)
  const leftPrerelease = leftDash < 0 ? '' : leftVersion.slice(leftDash + 1)
  const rightPrerelease = rightDash < 0 ? '' : rightVersion.slice(rightDash + 1)
  const leftParts = leftCore.split('.').map(Number)
  const rightParts = rightCore.split('.').map(Number)
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] > rightParts[index]) return 1
    if (leftParts[index] < rightParts[index]) return -1
  }
  if (!leftPrerelease && rightPrerelease) return 1
  if (leftPrerelease && !rightPrerelease) return -1
  if (leftPrerelease && rightPrerelease) {
    const leftIdentifiers = leftPrerelease.split('.')
    const rightIdentifiers = rightPrerelease.split('.')
    for (let index = 0; index < Math.max(leftIdentifiers.length, rightIdentifiers.length); index += 1) {
      if (leftIdentifiers[index] === undefined) return -1
      if (rightIdentifiers[index] === undefined) return 1
      if (leftIdentifiers[index] === rightIdentifiers[index]) continue
      const leftNumeric = /^\d+$/.test(leftIdentifiers[index])
      const rightNumeric = /^\d+$/.test(rightIdentifiers[index])
      if (leftNumeric && rightNumeric) {
        return Number(leftIdentifiers[index]) > Number(rightIdentifiers[index]) ? 1 : -1
      }
      if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1
      return leftIdentifiers[index] > rightIdentifiers[index] ? 1 : -1
    }
  }
  return 0
}

function readArg(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  generatePluginIndex({
    repoRoot: readArg('--repo-root'),
    baselineIndexPath: readArg('--baseline'),
    baseUrl: process.env.PLUGIN_BASE_URL || readArg('--base-url'),
    repository: process.env.PLUGIN_REPOSITORY || readArg('--repository'),
    homepage: process.env.PLUGIN_HOMEPAGE || readArg('--homepage'),
    validateOnly: process.argv.includes('--validate'),
    write: !process.argv.includes('--validate')
  })
    .then((index) => {
      console.log(
        `${process.argv.includes('--validate') ? 'Validated' : 'Generated'} ${index.plugins.length} plugin entries`
      )
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error))
      process.exitCode = 1
    })
}
