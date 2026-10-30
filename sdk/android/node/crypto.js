import { base64ToBytes, bytesToBase64, hostCall, toBytes } from '../runtime/host.js'
import { Buffer } from '../runtime/buffer.js'
import { getRandomValues, randomBytesRaw, randomUUID, webcrypto } from '../runtime/webcrypto.js'
import { queueMacrotask } from '../runtime/loop.js'

// node:crypto subset. Digests and ciphers run in the Android host
// (java.security / javax.crypto); data is buffered until digest()/final().

export const constants = {
  RSA_PKCS1_PADDING: 1,
  RSA_NO_PADDING: 3,
  RSA_PKCS1_OAEP_PADDING: 4,
  RSA_PKCS1_PSS_PADDING: 6
}

const HASHES = ['md5', 'sha1', 'sha224', 'sha256', 'sha384', 'sha512']
const CIPHERS = [
  'aes-128-ecb', 'aes-192-ecb', 'aes-256-ecb',
  'aes-128-cbc', 'aes-192-cbc', 'aes-256-cbc',
  'aes-128-ctr', 'aes-192-ctr', 'aes-256-ctr',
  'aes-128-gcm', 'aes-192-gcm', 'aes-256-gcm'
]

function normalizeHash(algorithm) {
  const name = String(algorithm).toLowerCase().replace(/^rsa-/, '').replace(/-/g, '')
  if (!HASHES.includes(name)) throw new Error(`Digest method not supported: ${algorithm}`)
  return name
}

function inputBytes(data, encoding) {
  if (typeof data === 'string') return Buffer.from(data, encoding || 'utf8')
  if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) return toBytes(data)
  throw new TypeError('The "data" argument must be of type string or an instance of Buffer, TypedArray, or DataView.')
}

function joinBytes(chunks) {
  let total = 0
  for (const chunk of chunks) total += chunk.length
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

function output(bytes, encoding) {
  const buffer = Buffer.from(bytes)
  return encoding && encoding !== 'buffer' ? buffer.toString(encoding) : buffer
}

function keyBytes(key, encoding) {
  if (key && typeof key === 'object' && key._secret) return key._secret
  return inputBytes(key, encoding)
}

class Hash {
  constructor(algorithm, chunks) {
    this._algorithm = normalizeHash(algorithm)
    this._chunks = chunks || []
    this._done = false
  }
  update(data, encoding) {
    if (this._done) throw new Error('Digest already called')
    this._chunks.push(inputBytes(data, encoding).slice())
    return this
  }
  digest(encoding) {
    if (this._done) throw new Error('Digest already called')
    this._done = true
    const result = hostCall('crypto.hash', { algorithm: this._algorithm, data: bytesToBase64(joinBytes(this._chunks)) })
    return output(base64ToBytes(result), encoding)
  }
  copy() {
    return new Hash(this._algorithm, this._chunks.slice())
  }
}

class Hmac {
  constructor(algorithm, key) {
    this._algorithm = normalizeHash(algorithm)
    this._key = keyBytes(key)
    this._chunks = []
    this._done = false
  }
  update(data, encoding) {
    if (this._done) throw new Error('Digest already called')
    this._chunks.push(inputBytes(data, encoding).slice())
    return this
  }
  digest(encoding) {
    if (this._done) throw new Error('Digest already called')
    this._done = true
    const result = hostCall('crypto.hmac', {
      algorithm: this._algorithm,
      key: bytesToBase64(this._key),
      data: bytesToBase64(joinBytes(this._chunks))
    })
    return output(base64ToBytes(result), encoding)
  }
}

export function createHash(algorithm) {
  return new Hash(algorithm)
}

export function createHmac(algorithm, key) {
  return new Hmac(algorithm, key)
}

export function hash(algorithm, data, encoding = 'hex') {
  return createHash(algorithm).update(data).digest(encoding)
}

class Cipher {
  constructor(algorithm, key, iv, decrypt, options) {
    const name = String(algorithm).toLowerCase()
    if (!CIPHERS.includes(name)) throw new Error(`Unsupported cipher: ${algorithm}`)
    this._algorithm = name
    this._key = keyBytes(key)
    this._iv = iv === null || iv === undefined ? null : inputBytes(iv)
    this._decrypt = decrypt
    this._padding = !/-(ctr|gcm)$/.test(name)
    this._chunks = []
    this._aad = null
    this._authTag = null
    this._authTagLength = (options && options.authTagLength) || 16
    this._done = false
  }
  setAutoPadding(enabled = true) {
    this._padding = Boolean(enabled)
    return this
  }
  setAAD(buffer) {
    this._aad = inputBytes(buffer).slice()
    return this
  }
  setAuthTag(tag) {
    this._authTag = inputBytes(tag).slice()
    return this
  }
  getAuthTag() {
    if (!this._authTag) throw new Error('Attempting to get auth tag in unsupported state')
    return Buffer.from(this._authTag)
  }
  update(data, inputEncoding, outputEncoding) {
    if (this._done) throw new Error('Unsupported state')
    this._chunks.push(inputBytes(data, inputEncoding).slice())
    return output(new Uint8Array(0), outputEncoding)
  }
  final(outputEncoding) {
    if (this._done) throw new Error('Unsupported state')
    this._done = true
    const args = {
      algorithm: this._algorithm,
      key: bytesToBase64(this._key),
      iv: this._iv ? bytesToBase64(this._iv) : null,
      data: bytesToBase64(joinBytes(this._chunks)),
      decrypt: this._decrypt,
      padding: this._padding
    }
    if (this._aad) args.aad = bytesToBase64(this._aad)
    if (this._decrypt && this._authTag) args.authTag = bytesToBase64(this._authTag)
    if (/-gcm$/.test(this._algorithm)) args.authTagLength = this._authTagLength
    const result = hostCall('crypto.cipher', args)
    if (result.authTag) this._authTag = base64ToBytes(result.authTag)
    return output(base64ToBytes(result.data), outputEncoding)
  }
}

export function createCipheriv(algorithm, key, iv, options) {
  return new Cipher(algorithm, key, iv, false, options)
}

export function createDecipheriv(algorithm, key, iv, options) {
  return new Cipher(algorithm, key, iv, true, options)
}

function pemOf(key) {
  if (typeof key === 'string') return key
  if (key instanceof Uint8Array) return Buffer.from(key).toString('utf8')
  if (key && key._pem) return key._pem
  if (key && key.key !== undefined) return pemOf(key.key)
  throw new TypeError('Unsupported key: expected a PEM string')
}

export function publicEncrypt(key, buffer) {
  const options = key && typeof key === 'object' && !(key instanceof Uint8Array) && !key._pem ? key : {}
  const padding = options.padding === undefined ? constants.RSA_PKCS1_OAEP_PADDING : options.padding
  const result = hostCall('crypto.publicEncrypt', {
    key: pemOf(key),
    padding,
    oaepHash: options.oaepHash ? normalizeHash(options.oaepHash) : 'sha1',
    data: bytesToBase64(inputBytes(buffer))
  })
  return Buffer.from(base64ToBytes(result))
}

class KeyObject {
  constructor(type, pem, secret) {
    this.type = type
    this._pem = pem
    this._secret = secret
  }
  export(options) {
    if (this._secret) return Buffer.from(this._secret)
    if (options && options.format === 'der') throw new Error('DER export is not supported on Android')
    return this._pem
  }
  get symmetricKeySize() {
    return this._secret ? this._secret.length : undefined
  }
}

export function createPublicKey(key) {
  return new KeyObject('public', pemOf(key), null)
}

export function createSecretKey(key, encoding) {
  return new KeyObject('secret', null, inputBytes(key, encoding).slice())
}

export function pbkdf2Sync(password, salt, iterations, keylen, digest) {
  const result = hostCall('crypto.pbkdf2', {
    password: bytesToBase64(inputBytes(password)),
    salt: bytesToBase64(inputBytes(salt)),
    iterations: Number(iterations),
    keyLength: Number(keylen),
    digest: normalizeHash(digest || 'sha1')
  })
  return Buffer.from(base64ToBytes(result))
}

export function pbkdf2(password, salt, iterations, keylen, digest, callback) {
  queueMacrotask(() => {
    let result
    try {
      result = pbkdf2Sync(password, salt, iterations, keylen, digest)
    } catch (error) {
      callback(error)
      return
    }
    callback(null, result)
  })
}

export function randomBytes(size, callback) {
  const bytes = Buffer.from(randomBytesRaw(size))
  if (typeof callback === 'function') {
    queueMacrotask(() => callback(null, bytes))
    return undefined
  }
  return bytes
}

export const pseudoRandomBytes = randomBytes

export function randomFillSync(buffer, offset = 0, size) {
  const view = toBytes(buffer)
  const count = size === undefined ? view.length - offset : size
  view.set(randomBytesRaw(count), offset)
  return buffer
}

export function randomInt(min, max, callback) {
  if (max === undefined || typeof max === 'function') {
    callback = max
    max = min
    min = 0
  }
  const range = max - min
  if (!(range > 0)) throw new RangeError('The value of "max" is out of range.')
  const bytes = randomBytesRaw(6)
  let value = 0
  for (const byte of bytes) value = value * 256 + byte
  const result = min + (value % range)
  if (typeof callback === 'function') {
    queueMacrotask(() => callback(null, result))
    return undefined
  }
  return result
}

export function timingSafeEqual(a, b) {
  const left = toBytes(a)
  const right = toBytes(b)
  if (left.length !== right.length) throw new RangeError('Input buffers must have the same byte length')
  let diff = 0
  for (let i = 0; i < left.length; i++) diff |= left[i] ^ right[i]
  return diff === 0
}

export function getHashes() {
  return HASHES.slice()
}

export function getCiphers() {
  return CIPHERS.slice()
}

function unsupported(name) {
  return () => {
    throw new Error(`crypto.${name} 在 Android 插件运行时中不可用`)
  }
}

export const createSign = unsupported('createSign')
export const createVerify = unsupported('createVerify')
export const generateKeyPair = unsupported('generateKeyPair')
export const generateKeyPairSync = unsupported('generateKeyPairSync')
export const createPrivateKey = unsupported('createPrivateKey')
export const privateDecrypt = unsupported('privateDecrypt')
export const privateEncrypt = unsupported('privateEncrypt')
export const publicDecrypt = unsupported('publicDecrypt')
export const scryptSync = unsupported('scryptSync')

export { getRandomValues, randomUUID, webcrypto, KeyObject }
export const subtle = webcrypto.subtle

export default {
  constants,
  createHash,
  createHmac,
  hash,
  createCipheriv,
  createDecipheriv,
  publicEncrypt,
  createPublicKey,
  createSecretKey,
  pbkdf2,
  pbkdf2Sync,
  randomBytes,
  pseudoRandomBytes,
  randomFillSync,
  randomInt,
  randomUUID,
  getRandomValues,
  timingSafeEqual,
  getHashes,
  getCiphers,
  createSign,
  createVerify,
  generateKeyPair,
  generateKeyPairSync,
  createPrivateKey,
  privateDecrypt,
  privateEncrypt,
  publicDecrypt,
  scryptSync,
  webcrypto,
  KeyObject
}
