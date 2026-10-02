import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Official limit: https://pages.edgeone.ai/document/limits-and-quotas
// Use decimal MB conservatively so every emitted file fits within 25 MB.
const MAX_FILE_BYTES = 25 * 1000 * 1000
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function checkSize(name, size) {
  if (size > MAX_FILE_BYTES) {
    throw new Error(`${name}: ${size} bytes exceeds the EdgeOne Makers single-file limit of 25 MB (${MAX_FILE_BYTES} bytes). Publish a smaller package or host it externally.`)
  }
}

async function readDistributionFile(path, name) {
  let info
  try {
    info = await lstat(path)
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`Missing distribution file: ${name}`)
    throw error
  }
  if (!info.isFile()) throw new Error(`${name}: expected a regular file (no symlinks)`)
  checkSize(name, info.size)
  return readFile(path)
}

export async function buildEdgeOneMirror(root = repoRoot) {
  root = await realpath(root)
  const indexBytes = await readDistributionFile(join(root, 'plugins.json'), 'plugins.json')
  const index = JSON.parse(indexBytes.toString('utf8'))
  if (index.schemaVersion !== 1 || !Array.isArray(index.plugins)) {
    throw new Error('plugins.json: expected a schemaVersion 1 plugin index')
  }

  const packages = new Map()
  let externalCount = 0
  for (const entry of index.plugins) {
    const source = entry.sourceUrl
    if (typeof source !== 'string') throw new Error(`${entry.id}: missing sourceUrl`)
    // Reviewed/community release URLs remain external; never download or rewrite them.
    if (/^https?:\/\//i.test(source)) {
      new URL(source)
      externalCount++
      continue
    }
    // Only publish direct children of packages/, matching the index generator.
    const match = /^(?:\.\/|\/)?packages\/([A-Za-z0-9][A-Za-z0-9._-]*\.tep)$/.exec(source)
    if (!match) throw new Error(`${entry.id}: unsupported local package URL: ${source}`)
    const name = match[1]
    const packageDir = join(root, 'packages')
    if ((await lstat(packageDir)).isSymbolicLink()) throw new Error('packages/ must not be a symlink')
    const bytes = packages.get(name) ?? await readDistributionFile(join(packageDir, name), source)
    const hash = createHash('sha256').update(bytes).digest('hex')
    if (hash !== entry.checksumSha256?.toLowerCase()) {
      throw new Error(`${source}: SHA-256 does not match plugins.json; rebuild and commit the package and index together`)
    }
    packages.set(name, bytes)
  }

  // Validate first, then replace only this repository's fixed dist directory.
  const output = resolve(root, 'dist')
  if (dirname(output) !== root) throw new Error('Output directory must be inside the repository')
  const outputInfo = await lstat(output).catch(error => {
    if (error.code !== 'ENOENT') throw error
  })
  if (outputInfo?.isSymbolicLink()) throw new Error('dist/ must not be a symlink')
  await rm(output, { recursive: true, force: true })
  await mkdir(join(output, 'packages'), { recursive: true })
  await writeFile(join(output, 'plugins.json'), indexBytes)
  for (const [name, bytes] of packages) await writeFile(join(output, 'packages', name), bytes)
  await writeFile(join(output, 'index.html'), `<!doctype html>
<html lang="zh-CN">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Twilight Echo 插件镜像</title>
<h1>Twilight Echo 插件镜像</h1>
<p><a href="./plugins.json">下载插件索引 plugins.json</a></p>
<p>本地插件包通过索引中的 packages/*.tep 地址下载。外部插件保持原始下载地址。</p>
</html>
`)
  console.log(`EdgeOne mirror built: ${output} (${packages.size} local packages, ${externalCount} external URLs preserved)`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildEdgeOneMirror().catch(error => {
    console.error(`EdgeOne mirror build failed: ${error.message}`)
    process.exitCode = 1
  })
}
