import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compareSemver, generatePluginIndex, inspectCommunityAsset } from './generate-index.mjs'

const TOPIC = 'twilight-echo-plugin'
const SEARCH_URL = `https://api.github.com/search/repositories?q=${encodeURIComponent(`topic:${TOPIC} fork:false archived:false`)}&per_page=100`
const REPOSITORY_NAME = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/
const MAX_PACKAGE_BYTES = 50 * 1024 * 1024

export async function discoverCommunityPlugins(options = {}) {
  const repoRoot = resolve(options.repoRoot ?? resolve(import.meta.dirname, '..'))
  const fetchImpl = options.fetchImpl ?? fetch
  const token = options.token ?? process.env.GITHUB_TOKEN
  const communityPath = join(repoRoot, 'community.json')
  const previous = existsSync(communityPath)
    ? JSON.parse(await readFile(communityPath, 'utf8'))
    : { schemaVersion: 1, owners: {}, history: {}, plugins: [] }
  if (previous.schemaVersion !== 1 || !Array.isArray(previous.plugins) ||
      !previous.owners || typeof previous.owners !== 'object' || Array.isArray(previous.owners) ||
      (previous.history !== undefined &&
        (!previous.history || typeof previous.history !== 'object' || Array.isArray(previous.history)))) {
    throw new Error('community.json 格式无效')
  }
  const curated = await generatePluginIndex({ repoRoot, fetchImpl, communityEntries: [] })
  const curatedIds = new Set(curated.plugins.map((plugin) => plugin.id))
  const repositories = await searchRepositories(fetchImpl, token)
  const candidates = []
  for (const repo of repositories) {
    if (!REPOSITORY_NAME.test(repo.full_name) || repo.private || repo.archived || repo.fork) continue
    const repository = `https://github.com/${repo.full_name}`
    const release = await githubJson(
      `https://api.github.com/repos/${repo.full_name}/releases/latest`,
      fetchImpl,
      token,
      true
    )
    if (!release) continue
    const assets = Array.isArray(release.assets)
      ? release.assets.filter((asset) => typeof asset.name === 'string' && asset.name.endsWith('.tep'))
      : []
    if (assets.length !== 1) {
      if (assets.length > 1) console.warn(`${repository}: 最新 Release 必须只有一个 .tep`)
      continue
    }
    const asset = assets[0]
    if (!Number.isInteger(asset.size) || asset.size > MAX_PACKAGE_BYTES) {
      console.warn(`${repository}: .tep 大小无效`)
      continue
    }
    const tags = Array.isArray(repo.topics)
      ? repo.topics.filter((topic) => typeof topic === 'string' && topic !== TOPIC)
      : []
    try {
      const candidate = await inspectCommunityAsset({
        repository,
        sourceUrl: asset.browser_download_url,
        tags
      }, fetchImpl)
      candidates.push(candidate)
    } catch (error) {
      console.warn(`${repository}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const byId = new Map()
  for (const candidate of candidates) {
    const { descriptor } = candidate
    if (curatedIds.has(descriptor.id)) continue
    const owner = previous.owners[descriptor.id]
    if (owner && owner !== descriptor.repository) continue
    const group = byId.get(descriptor.id) ?? []
    group.push(candidate)
    byId.set(descriptor.id, group)
  }

  const owners = { ...previous.owners }
  const history = { ...Object.fromEntries(previous.plugins.map((plugin) => [plugin.id, {
    version: plugin.version,
    checksumSha256: plugin.checksumSha256
  }])), ...previous.history }
  const descriptors = []
  const entries = []
  for (const [id, group] of byId) {
    if (group.length !== 1) {
      console.warn(`${id}: 多个仓库声明同一插件 ID，已跳过`)
      continue
    }
    const candidate = group[0]
    const last = history[id]
    if (last && (compareSemver(candidate.descriptor.version, last.version) < 0 ||
        (candidate.descriptor.version === last.version &&
          candidate.descriptor.checksumSha256 !== last.checksumSha256))) {
      console.warn(`${id}: 版本回退或同版本安装包变更，已跳过`)
      continue
    }
    owners[id] = candidate.descriptor.repository
    history[id] = {
      version: candidate.descriptor.version,
      checksumSha256: candidate.descriptor.checksumSha256
    }
    descriptors.push(candidate.descriptor)
    entries.push(candidate.entry)
  }

  descriptors.sort((left, right) => left.id.localeCompare(right.id))
  const community = { schemaVersion: 1, owners, history, plugins: descriptors }
  const index = await generatePluginIndex({ repoRoot, fetchImpl, communityEntries: entries })
  if (options.write !== false) {
    await writeFile(communityPath, `${JSON.stringify(community, null, 2)}\n`)
    await writeFile(join(repoRoot, 'plugins.json'), `${JSON.stringify(index, null, 2)}\n`)
  }
  return { community, index, scannedRepositories: repositories.length }
}

async function searchRepositories(fetchImpl, token) {
  const repositories = []
  for (let page = 1; page <= 10; page += 1) {
    const result = await githubJson(`${SEARCH_URL}&page=${page}`, fetchImpl, token)
    if (result.incomplete_results || !Array.isArray(result.items) || result.total_count > 1000) {
      throw new Error('GitHub Topic 搜索结果不完整')
    }
    repositories.push(...result.items)
    if (result.items.length < 100) return repositories
  }
  return repositories
}

async function githubJson(url, fetchImpl, token, missingAllowed = false) {
  const response = await fetchImpl(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'twilight-echo-plugin-index',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    signal: AbortSignal.timeout(30_000)
  })
  if (missingAllowed && response.status === 404) return null
  if (!response.ok) throw new Error(`GitHub API 请求失败：${response.status} ${url}`)
  return await response.json()
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const rootIndex = process.argv.indexOf('--repo-root')
  discoverCommunityPlugins({
    repoRoot: rootIndex >= 0 ? process.argv[rootIndex + 1] : undefined,
    write: !process.argv.includes('--dry-run')
  })
    .then(({ community, scannedRepositories }) => {
      console.log(`Scanned ${scannedRepositories} repositories; indexed ${community.plugins.length} community plugins`)
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error))
      process.exitCode = 1
    })
}
