// node:path (POSIX semantics on Android).
function assertPath(path) {
  if (typeof path !== 'string') throw new TypeError('The "path" argument must be of type string. Received ' + typeof path)
}

function normalizeString(path, allowAboveRoot) {
  const out = []
  for (const segment of path.split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      if (out.length && out[out.length - 1] !== '..') out.pop()
      else if (allowAboveRoot) out.push('..')
    } else out.push(segment)
  }
  return out.join('/')
}

export const sep = '/'
export const delimiter = ':'

function cwd() {
  return '/'
}

export function resolve(...paths) {
  let resolved = ''
  let absolute = false
  for (let i = paths.length - 1; i >= -1 && !absolute; i--) {
    const path = i >= 0 ? paths[i] : cwd()
    assertPath(path)
    if (!path) continue
    resolved = path + '/' + resolved
    absolute = path.charCodeAt(0) === 47
  }
  const normalized = normalizeString(resolved, !absolute)
  return absolute ? '/' + normalized : normalized || '.'
}

export function normalize(path) {
  assertPath(path)
  if (!path) return '.'
  const absolute = path.charCodeAt(0) === 47
  const trailing = path.charCodeAt(path.length - 1) === 47
  let normalized = normalizeString(path, !absolute)
  if (!normalized && !absolute) normalized = '.'
  if (normalized && trailing) normalized += '/'
  return absolute ? '/' + normalized : normalized
}

export function isAbsolute(path) {
  assertPath(path)
  return path.charCodeAt(0) === 47
}

export function join(...paths) {
  const joined = paths
    .filter((path) => {
      assertPath(path)
      return path.length > 0
    })
    .join('/')
  return joined ? normalize(joined) : '.'
}

export function relative(from, to) {
  const fromParts = resolve(from).split('/').filter(Boolean)
  const toParts = resolve(to).split('/').filter(Boolean)
  let i = 0
  while (i < fromParts.length && i < toParts.length && fromParts[i] === toParts[i]) i++
  return [...fromParts.slice(i).map(() => '..'), ...toParts.slice(i)].join('/')
}

export function dirname(path) {
  assertPath(path)
  if (!path) return '.'
  const trimmed = path.replace(/\/+$/, '') || '/'
  if (trimmed === '/') return '/'
  const index = trimmed.lastIndexOf('/')
  if (index < 0) return '.'
  if (index === 0) return '/'
  return trimmed.slice(0, index).replace(/\/+$/, '') || '/'
}

export function basename(path, ext) {
  assertPath(path)
  const trimmed = path.replace(/\/+$/, '')
  let base = trimmed.slice(trimmed.lastIndexOf('/') + 1)
  if (ext && base.endsWith(ext) && base !== ext) base = base.slice(0, base.length - ext.length)
  return base
}

export function extname(path) {
  const base = basename(path)
  const index = base.lastIndexOf('.')
  return index <= 0 ? '' : base.slice(index)
}

export function parse(path) {
  const root = path.startsWith('/') ? '/' : ''
  const base = basename(path)
  const ext = extname(path)
  let dir = dirname(path)
  if (dir === '.' && !path.includes('/')) dir = ''
  return { root, dir, base, ext, name: ext ? base.slice(0, base.length - ext.length) : base }
}

export function format(object) {
  const dir = object.dir || object.root || ''
  const base = object.base || (object.name || '') + (object.ext || '')
  if (!dir) return base
  return dir === object.root ? dir + base : dir + '/' + base
}

export function toNamespacedPath(path) {
  return path
}

const path = { sep, delimiter, resolve, normalize, isAbsolute, join, relative, dirname, basename, extname, parse, format, toNamespacedPath }
path.posix = path
path.win32 = path

export const posix = path
export const win32 = path
export default path
