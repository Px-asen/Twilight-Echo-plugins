import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const MAX_PACKAGE_BYTES = 50 * 1024 * 1024
export const PACKAGE_CACHE_CONTROL = 'public, max-age=31536000, immutable'
export const INDEX_CACHE_CONTROL = 'public, max-age=60'
const LOCAL_PACKAGE = /^(?:\.\/)?packages\/([A-Za-z0-9][A-Za-z0-9._-]*\.tep)$/

async function readPackage(path) {
  const info = await lstat(path)
  if (!info.isFile() || info.size > MAX_PACKAGE_BYTES) {
    throw new Error(`${path}: expected a regular package no larger than 50 MiB`)
  }
  return readFile(path)
}

async function downloadPackage(url, fetchImpl) {
  if (new URL(url).protocol !== 'https:') throw new Error(`Package URL must use HTTPS: ${url}`)
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(60_000) })
  if (!response.ok || !response.body) throw new Error(`Package download failed (${response.status}): ${url}`)
  if (Number(response.headers.get('content-length')) > MAX_PACKAGE_BYTES) {
    await response.body.cancel()
    throw new Error(`Package exceeds 50 MiB: ${url}`)
  }
  const chunks = []
  let size = 0
  for await (const chunk of response.body) {
    size += chunk.byteLength
    if (size > MAX_PACKAGE_BYTES) throw new Error(`Package exceeds 50 MiB: ${url}`)
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, size)
}

export async function buildR2({ root = repoRoot, fetchImpl = fetch } = {}) {
  root = await realpath(root)
  const config = JSON.parse(await readFile(join(root, 'r2.json'), 'utf8'))
  const index = JSON.parse(await readFile(join(root, 'plugins.json'), 'utf8'))
  if (index.schemaVersion !== 1 || !Array.isArray(index.plugins)) {
    throw new Error('plugins.json must contain a schemaVersion 1 plugin index')
  }
  const output = join(root, 'dist', 'r2')
  const staging = join(root, 'dist', 'r2-staging')
  await mkdir(join(root, 'dist'), { recursive: true })
  if ((await realpath(join(root, 'dist'))) !== join(root, 'dist')) {
    throw new Error('dist/ must not be a symlink')
  }
  // Only these fixed, repository-local build directories are ever replaced.
  for (const path of [output, staging]) {
    const info = await lstat(path).catch(error => {
      if (error.code !== 'ENOENT') throw error
    })
    if (info?.isSymbolicLink()) throw new Error(`${path} must not be a symlink`)
  }
  await rm(staging, { recursive: true, force: true })
  await mkdir(join(staging, 'packages'), { recursive: true })
  const plugins = []
  const objects = []
  const excluded = []
  try {
    for (const entry of index.plugins) {
      if (config.excludedPlugins?.[entry.id]) {
        excluded.push({ id: entry.id, reason: config.excludedPlugins[entry.id] })
        continue
      }
      if (entry.publisherSignature) {
        throw new Error(`${entry.id}: publisher signature binds the original index URL; re-sign for the R2 index before publishing`)
      }
      if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)+$/.test(entry.id) ||
          !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(entry.version) ||
          !/^[a-f0-9]{64}$/i.test(entry.checksumSha256 ?? '')) {
        throw new Error(`${entry.id}: invalid id, version or SHA-256`)
      }
      const source = entry.sourceUrl
      const local = typeof source === 'string' ? LOCAL_PACKAGE.exec(source) : null
      let bytes
      if (local) {
        if ((await lstat(join(root, 'packages'))).isSymbolicLink()) throw new Error('packages/ must not be a symlink')
        bytes = await readPackage(join(root, 'packages', local[1]))
      } else if (typeof source === 'string' && /^https:\/\//i.test(source)) {
        bytes = await downloadPackage(source, fetchImpl)
      } else {
        throw new Error(`${entry.id}: unsupported sourceUrl: ${source}`)
      }
      const sha256 = createHash('sha256').update(bytes).digest('hex')
      if (sha256 !== entry.checksumSha256.toLowerCase()) throw new Error(`${entry.id}: SHA-256 mismatch`)
      // Content-addressed filenames cannot serve stale bytes after a same-version rebuild.
      const key = `packages/${entry.id}-${entry.version}-${sha256}.tep`
      await writeFile(join(staging, key), bytes)
      plugins.push({ ...entry, sourceUrl: key })
      objects.push({ key, size: bytes.length, sha256 })
    }
    await writeFile(join(staging, 'plugins.json'), `${JSON.stringify({ ...index, plugins }, null, 2)}\n`)
    await writeFile(join(staging, 'deployment.json'), `${JSON.stringify({ schemaVersion: 1, objects, excluded }, null, 2)}\n`)
    await rm(output, { recursive: true, force: true })
    await rename(staging, output)
    console.log(`R2 distribution built: ${output} (${objects.length} packages, ${excluded.length} excluded)`)
    for (const entry of excluded) console.log(`Excluded ${entry.id}: ${entry.reason}`)
    return { output, objects, excluded }
  } catch (error) {
    await rm(staging, { recursive: true, force: true })
    throw error
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildR2().catch(error => { console.error(error.message); process.exitCode = 1 })
}
