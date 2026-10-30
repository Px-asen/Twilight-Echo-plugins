import { base64ToBytes, hostCall } from './host.js'
import { TwilightPromise as Promise } from './loop.js'

/** Cryptographically secure bytes from the Android host (SecureRandom). */
export function randomBytesRaw(size) {
  const length = Math.max(0, Math.floor(Number(size) || 0))
  if (!length) return new Uint8Array(0)
  const out = new Uint8Array(length)
  // The host caps one call at 64 KiB.
  for (let offset = 0; offset < length; offset += 65536) {
    const count = Math.min(65536, length - offset)
    out.set(base64ToBytes(hostCall('crypto.random', { size: count })), offset)
  }
  return out
}

export function getRandomValues(array) {
  if (!ArrayBuffer.isView(array) || array instanceof Float32Array || array instanceof Float64Array) {
    throw new TypeError("The data argument must be an integer-type TypedArray")
  }
  if (array.byteLength > 65536) throw new RangeError('The ArrayBufferView byte length exceeds 65536')
  new Uint8Array(array.buffer, array.byteOffset, array.byteLength).set(randomBytesRaw(array.byteLength))
  return array
}

export function randomUUID() {
  const bytes = randomBytesRaw(16)
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  let hex = ''
  for (let i = 0; i < 16; i++) hex += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

// SubtleCrypto is not implemented; probing for it works, calling it rejects.
const subtle = {}
for (const name of ['decrypt', 'deriveBits', 'deriveKey', 'digest', 'encrypt', 'exportKey', 'generateKey', 'importKey', 'sign', 'unwrapKey', 'verify', 'wrapKey']) {
  subtle[name] = () => Promise.reject(new Error(`crypto.subtle.${name} 在 Android 插件运行时中不可用`))
}

export const webcrypto = { getRandomValues, randomUUID, subtle }
