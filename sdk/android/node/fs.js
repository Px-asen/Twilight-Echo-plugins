import { Buffer } from '../runtime/buffer.js'
import { TwilightPromise as Promise, queueMacrotask } from '../runtime/loop.js'
import { dirname, resolve as resolvePath } from './path.js'
import { URL } from '../runtime/url.js'

// node:fs backed by an in-memory store. Android plugins have no file system;
// this keeps libraries that cache to disk working for the lifetime of the VM.

const files = new Map()
const dirs = new Set(['/'])

function fsError(code, syscall, path) {
  const messages = { ENOENT: 'no such file or directory', EEXIST: 'file already exists', EISDIR: 'illegal operation on a directory', ENOTDIR: 'not a directory', ENOTEMPTY: 'directory not empty' }
  const error = new Error(`${code}: ${messages[code] || 'operation failed'}, ${syscall} '${path}'`)
  error.code = code
  error.errno = -1
  error.syscall = syscall
  error.path = path
  return error
}

function key(path) {
  if (path instanceof URL) return resolvePath(decodeURIComponent(path.pathname))
  if (path instanceof Uint8Array) return resolvePath(Buffer.from(path).toString())
  return resolvePath(String(path))
}

function encodingOf(options) {
  if (typeof options === 'string') return options
  return options && options.encoding ? options.encoding : null
}

function toBuffer(data, options) {
  if (typeof data === 'string') return Buffer.from(data, encodingOf(options) || 'utf8')
  if (data instanceof ArrayBuffer) return Buffer.from(new Uint8Array(data))
  if (ArrayBuffer.isView(data)) return Buffer.from(new Uint8Array(data.buffer, data.byteOffset, data.byteLength))
  return Buffer.from(String(data))
}

function ensureParent(path, syscall) {
  if (!dirs.has(dirname(path))) throw fsError('ENOENT', syscall, path)
}

class Stats {
  constructor(isDir, size) {
    const now = new Date()
    this.size = size
    this.mode = isDir ? 0o40755 : 0o100644
    this.mtime = now
    this.ctime = now
    this.atime = now
    this.birthtime = now
    this.mtimeMs = now.getTime()
    this._dir = isDir
  }
  isFile() {
    return !this._dir
  }
  isDirectory() {
    return this._dir
  }
  isSymbolicLink() {
    return false
  }
}

export function existsSync(path) {
  const target = key(path)
  return files.has(target) || dirs.has(target)
}

export function readFileSync(path, options) {
  const target = key(path)
  if (dirs.has(target)) throw fsError('EISDIR', 'read', target)
  const data = files.get(target)
  if (!data) throw fsError('ENOENT', 'open', target)
  const encoding = encodingOf(options)
  return encoding ? data.toString(encoding) : Buffer.from(data)
}

export function writeFileSync(path, data, options) {
  const target = key(path)
  ensureParent(target, 'open')
  if (dirs.has(target)) throw fsError('EISDIR', 'open', target)
  const flag = options && typeof options === 'object' ? options.flag : null
  const bytes = toBuffer(data, options)
  if (flag === 'a' && files.has(target)) files.set(target, Buffer.concat([files.get(target), bytes]))
  else files.set(target, bytes)
}

export function appendFileSync(path, data, options) {
  const target = key(path)
  ensureParent(target, 'open')
  files.set(target, Buffer.concat([files.get(target) || Buffer.alloc(0), toBuffer(data, options)]))
}

export function mkdirSync(path, options) {
  const target = key(path)
  const recursive = options && typeof options === 'object' && options.recursive
  if (dirs.has(target)) {
    if (recursive) return undefined
    throw fsError('EEXIST', 'mkdir', target)
  }
  if (files.has(target)) throw fsError('EEXIST', 'mkdir', target)
  if (!dirs.has(dirname(target))) {
    if (!recursive) throw fsError('ENOENT', 'mkdir', target)
    mkdirSync(dirname(target), { recursive: true })
  }
  dirs.add(target)
  return recursive ? target : undefined
}

export function readdirSync(path) {
  const target = key(path)
  if (!dirs.has(target)) throw fsError('ENOENT', 'scandir', target)
  const prefix = target === '/' ? '/' : target + '/'
  const names = new Set()
  for (const entry of [...files.keys(), ...dirs]) {
    if (entry !== target && entry.startsWith(prefix)) names.add(entry.slice(prefix.length).split('/')[0])
  }
  return Array.from(names).sort()
}

export function statSync(path, options) {
  const target = key(path)
  if (dirs.has(target)) return new Stats(true, 0)
  const data = files.get(target)
  if (!data) {
    if (options && options.throwIfNoEntry === false) return undefined
    throw fsError('ENOENT', 'stat', target)
  }
  return new Stats(false, data.length)
}

export const lstatSync = statSync

export function unlinkSync(path) {
  const target = key(path)
  if (!files.delete(target)) throw fsError('ENOENT', 'unlink', target)
}

export function rmSync(path, options) {
  const target = key(path)
  if (files.delete(target)) return
  if (dirs.has(target)) {
    const prefix = target + '/'
    const children = [...files.keys(), ...dirs].filter((entry) => entry.startsWith(prefix))
    if (children.length && !(options && options.recursive)) throw fsError('ENOTEMPTY', 'rm', target)
    for (const entry of children) {
      files.delete(entry)
      dirs.delete(entry)
    }
    dirs.delete(target)
    return
  }
  if (!(options && options.force)) throw fsError('ENOENT', 'rm', target)
}

export function rmdirSync(path, options) {
  rmSync(path, { recursive: options && options.recursive })
}

export function renameSync(from, to) {
  const source = key(from)
  const target = key(to)
  const data = files.get(source)
  if (!data) throw fsError('ENOENT', 'rename', source)
  ensureParent(target, 'rename')
  files.delete(source)
  files.set(target, data)
}

export function copyFileSync(from, to) {
  writeFileSync(to, readFileSync(from))
}

export function accessSync(path) {
  if (!existsSync(path)) throw fsError('ENOENT', 'access', key(path))
}

export function realpathSync(path) {
  return key(path)
}
realpathSync.native = realpathSync

export function mkdtempSync(prefix) {
  const target = key(prefix + Math.random().toString(36).slice(2, 8))
  mkdirSync(target, { recursive: true })
  return target
}

function unsupportedStream(name) {
  return () => {
    throw fsError('ENOENT', name, '')
  }
}

export const createReadStream = unsupportedStream('createReadStream')
export const createWriteStream = unsupportedStream('createWriteStream')
export const watch = unsupportedStream('watch')

export function openSync(path) {
  throw fsError('ENOENT', 'open', key(path))
}

function wrap(fn) {
  return (...args) => {
    const callback = typeof args[args.length - 1] === 'function' ? args.pop() : null
    queueMacrotask(() => {
      let result
      try {
        result = fn(...args)
      } catch (error) {
        if (callback) callback(error)
        return
      }
      if (callback) callback(null, result)
    })
  }
}

function promiseOf(fn) {
  return (...args) =>
    new Promise((resolve, reject) => {
      queueMacrotask(() => {
        try {
          resolve(fn(...args))
        } catch (error) {
          reject(error)
        }
      })
    })
}

export const readFile = wrap(readFileSync)
export const writeFile = wrap(writeFileSync)
export const appendFile = wrap(appendFileSync)
export const mkdir = wrap(mkdirSync)
export const readdir = wrap(readdirSync)
export const stat = wrap(statSync)
export const lstat = wrap(statSync)
export const unlink = wrap(unlinkSync)
export const rm = wrap(rmSync)
export const rmdir = wrap(rmdirSync)
export const rename = wrap(renameSync)
export const copyFile = wrap(copyFileSync)
export const access = wrap(accessSync)
export const realpath = wrap(realpathSync)
export function exists(path, callback) {
  queueMacrotask(() => callback(existsSync(path)))
}

export const promises = {
  readFile: promiseOf(readFileSync),
  writeFile: promiseOf(writeFileSync),
  appendFile: promiseOf(appendFileSync),
  mkdir: promiseOf(mkdirSync),
  readdir: promiseOf(readdirSync),
  stat: promiseOf(statSync),
  lstat: promiseOf(statSync),
  unlink: promiseOf(unlinkSync),
  rm: promiseOf(rmSync),
  rmdir: promiseOf(rmdirSync),
  rename: promiseOf(renameSync),
  copyFile: promiseOf(copyFileSync),
  access: promiseOf(accessSync),
  realpath: promiseOf(realpathSync),
  mkdtemp: promiseOf(mkdtempSync),
  open: promiseOf(openSync)
}

export const constants = { F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1, O_RDONLY: 0, O_WRONLY: 1, O_RDWR: 2, O_CREAT: 64, O_EXCL: 128, O_TRUNC: 512, O_APPEND: 1024 }

export { Stats }

export default {
  existsSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  mkdirSync,
  readdirSync,
  statSync,
  lstatSync,
  unlinkSync,
  rmSync,
  rmdirSync,
  renameSync,
  copyFileSync,
  accessSync,
  realpathSync,
  mkdtempSync,
  openSync,
  createReadStream,
  createWriteStream,
  watch,
  readFile,
  writeFile,
  appendFile,
  mkdir,
  readdir,
  stat,
  lstat,
  unlink,
  rm,
  rmdir,
  rename,
  copyFile,
  access,
  realpath,
  exists,
  promises,
  constants,
  Stats
}
