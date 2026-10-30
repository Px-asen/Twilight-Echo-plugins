import { base64ToBytes, bytesToBase64, hostCall, toBytes } from '../runtime/host.js'
import { Buffer } from '../runtime/buffer.js'
import { Transform } from './stream.js'
import { queueMacrotask } from '../runtime/loop.js'

// node:zlib over java.util.zip in the host. Streams buffer the whole input.
export const constants = {
  Z_NO_FLUSH: 0, Z_PARTIAL_FLUSH: 1, Z_SYNC_FLUSH: 2, Z_FULL_FLUSH: 3, Z_FINISH: 4,
  Z_OK: 0, Z_STREAM_END: 1, Z_BEST_SPEED: 1, Z_BEST_COMPRESSION: 9, Z_DEFAULT_COMPRESSION: -1,
  Z_MIN_CHUNK: 64, Z_MAX_CHUNK: Infinity, Z_DEFAULT_CHUNK: 16384,
  BROTLI_OPERATION_FLUSH: 1, BROTLI_OPERATION_FINISH: 2
}

function run(mode, input, options) {
  const data = typeof input === 'string' ? Buffer.from(input) : toBytes(input)
  const level = options && options.level !== undefined ? options.level : -1
  return Buffer.from(base64ToBytes(hostCall('zlib.process', { mode, level, data: bytesToBase64(data) })))
}

function syncFn(mode) {
  return (input, options) => run(mode, input, options)
}

function asyncFn(mode) {
  return (input, options, callback) => {
    if (typeof options === 'function') {
      callback = options
      options = {}
    }
    queueMacrotask(() => {
      let result
      try {
        result = run(mode, input, options)
      } catch (error) {
        callback(error)
        return
      }
      callback(null, result)
    })
  }
}

// Constructor functions, as in Node: npm code subclasses them with
// util.inherits (e.g. pngjs extends zlib.Inflate).
function ZlibBase(mode, options) {
  Transform.call(this, options)
  this._mode = mode
  this._zlibOptions = options || {}
  this._chunks = []
  this.bytesWritten = 0
}
Object.setPrototypeOf(ZlibBase.prototype, Transform.prototype)
Object.setPrototypeOf(ZlibBase, Transform)

ZlibBase.prototype._transform = function (chunk, encoding, callback) {
  const bytes = Buffer.from(chunk)
  this.bytesWritten += bytes.length
  this._chunks.push(bytes)
  callback()
}

ZlibBase.prototype._flush = function (callback) {
  let output
  try {
    output = run(this._mode, Buffer.concat(this._chunks), this._zlibOptions)
  } catch (error) {
    callback(error)
    return
  }
  this._chunks = []
  callback(null, output)
}

ZlibBase.prototype.flush = function (kind, callback) {
  if (typeof kind === 'function') callback = kind
  if (callback) queueMacrotask(callback)
}

ZlibBase.prototype.params = function (level, strategy, callback) {
  this._zlibOptions = { ...this._zlibOptions, level }
  if (callback) queueMacrotask(callback)
}

ZlibBase.prototype.reset = function () {
  this._chunks = []
}

ZlibBase.prototype.close = function (callback) {
  if (callback) queueMacrotask(callback)
  this.destroy()
}

function zlibClass(name, mode) {
  const Zlib = function (options) {
    if (!(this instanceof Zlib)) return new Zlib(options)
    ZlibBase.call(this, mode, options)
  }
  Object.defineProperty(Zlib, 'name', { value: name })
  Object.setPrototypeOf(Zlib.prototype, ZlibBase.prototype)
  Object.setPrototypeOf(Zlib, ZlibBase)
  return Zlib
}

export const Gzip = zlibClass('Gzip', 'gzip')
export const Gunzip = zlibClass('Gunzip', 'gunzip')
export const Deflate = zlibClass('Deflate', 'deflate')
export const Inflate = zlibClass('Inflate', 'inflate')
export const DeflateRaw = zlibClass('DeflateRaw', 'deflateRaw')
export const InflateRaw = zlibClass('InflateRaw', 'inflateRaw')
export const Unzip = zlibClass('Unzip', 'unzip')
export const BrotliCompress = zlibClass('BrotliCompress', 'brotliCompress')
export const BrotliDecompress = zlibClass('BrotliDecompress', 'brotliDecompress')

export const gzipSync = syncFn('gzip')
export const gunzipSync = syncFn('gunzip')
export const deflateSync = syncFn('deflate')
export const inflateSync = syncFn('inflate')
export const deflateRawSync = syncFn('deflateRaw')
export const inflateRawSync = syncFn('inflateRaw')
export const unzipSync = syncFn('unzip')
export const brotliCompressSync = syncFn('brotliCompress')
export const brotliDecompressSync = syncFn('brotliDecompress')

export const gzip = asyncFn('gzip')
export const gunzip = asyncFn('gunzip')
export const deflate = asyncFn('deflate')
export const inflate = asyncFn('inflate')
export const deflateRaw = asyncFn('deflateRaw')
export const inflateRaw = asyncFn('inflateRaw')
export const unzip = asyncFn('unzip')
export const brotliCompress = asyncFn('brotliCompress')
export const brotliDecompress = asyncFn('brotliDecompress')

export const createGzip = (options) => new Gzip(options)
export const createGunzip = (options) => new Gunzip(options)
export const createDeflate = (options) => new Deflate(options)
export const createInflate = (options) => new Inflate(options)
export const createDeflateRaw = (options) => new DeflateRaw(options)
export const createInflateRaw = (options) => new InflateRaw(options)
export const createUnzip = (options) => new Unzip(options)
export const createBrotliCompress = (options) => new BrotliCompress(options)
export const createBrotliDecompress = (options) => new BrotliDecompress(options)

export default {
  // Node still exposes the legacy Z_* names on the module itself.
  ...constants,
  constants,
  Gzip, Gunzip, Deflate, Inflate, DeflateRaw, InflateRaw, Unzip, BrotliCompress, BrotliDecompress,
  gzipSync, gunzipSync, deflateSync, inflateSync, deflateRawSync, inflateRawSync, unzipSync, brotliCompressSync, brotliDecompressSync,
  gzip, gunzip, deflate, inflate, deflateRaw, inflateRaw, unzip, brotliCompress, brotliDecompress,
  createGzip, createGunzip, createDeflate, createInflate, createDeflateRaw, createInflateRaw, createUnzip, createBrotliCompress, createBrotliDecompress
}
