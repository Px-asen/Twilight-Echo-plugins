/* global __PLUGIN_HOST__ */
// Low-level bridge to the Android plugin host. Every host call is synchronous:
// the isolated worker blocks on Binder while the app process performs the IO.

export function hostCall(method, args) {
  if (typeof __PLUGIN_HOST__ === 'undefined') throw new Error('Twilight Android 插件宿主不可用')
  const raw = __PLUGIN_HOST__.call(method, JSON.stringify(args === undefined ? {} : args))
  const result = JSON.parse(raw)
  if (!result || result.ok !== true) {
    const error = new Error((result && result.error) || '插件宿主调用失败')
    if (result && result.code) error.code = result.code
    throw error
  }
  return result.value
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const B64_LOOKUP = new Int16Array(128).fill(-1)
for (let i = 0; i < B64.length; i++) B64_LOOKUP[B64.charCodeAt(i)] = i
B64_LOOKUP[45] = 62 // '-' (base64url)
B64_LOOKUP[95] = 63 // '_' (base64url)

export function bytesToBase64(bytes, url = false) {
  let out = ''
  const len = bytes.length
  let i = 0
  const parts = []
  for (; i + 2 < len; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2]
    out += B64[n >> 18] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63]
    if (out.length >= 8192) { parts.push(out); out = '' }
  }
  if (i < len) {
    const n = (bytes[i] << 16) | ((i + 1 < len ? bytes[i + 1] : 0) << 8)
    out += B64[n >> 18] + B64[(n >> 12) & 63]
    out += i + 1 < len ? B64[(n >> 6) & 63] : (url ? '' : '=')
    out += url ? '' : '='
  }
  parts.push(out)
  let text = parts.join('')
  if (url) text = text.replace(/\+/g, '-').replace(/\//g, '_')
  return text
}

export function base64ToBytes(text) {
  const clean = String(text).replace(/[\s=]+/g, '')
  const len = clean.length
  const out = new Uint8Array(Math.floor((len * 3) / 4))
  let o = 0
  let buffer = 0
  let bits = 0
  for (let i = 0; i < len; i++) {
    const code = clean.charCodeAt(i)
    const value = code < 128 ? B64_LOOKUP[code] : -1
    if (value < 0) continue
    buffer = (buffer << 6) | value
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out[o++] = (buffer >> bits) & 255
    }
  }
  return o === out.length ? out : out.subarray(0, o)
}

export function utf8Encode(text) {
  const str = String(text)
  const out = new Uint8Array(str.length * 3)
  let o = 0
  for (let i = 0; i < str.length; i++) {
    let code = str.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < str.length) {
      const next = str.charCodeAt(i + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00)
        i++
      } else code = 0xfffd
    } else if (code >= 0xd800 && code <= 0xdfff) code = 0xfffd
    if (code < 0x80) out[o++] = code
    else if (code < 0x800) {
      out[o++] = 0xc0 | (code >> 6)
      out[o++] = 0x80 | (code & 63)
    } else if (code < 0x10000) {
      out[o++] = 0xe0 | (code >> 12)
      out[o++] = 0x80 | ((code >> 6) & 63)
      out[o++] = 0x80 | (code & 63)
    } else {
      out[o++] = 0xf0 | (code >> 18)
      out[o++] = 0x80 | ((code >> 12) & 63)
      out[o++] = 0x80 | ((code >> 6) & 63)
      out[o++] = 0x80 | (code & 63)
    }
  }
  return out.slice(0, o)
}

export function utf8Decode(bytes, start = 0, end = bytes.length) {
  const parts = []
  let chunk = []
  let i = start
  while (i < end) {
    const b = bytes[i]
    let code = 0xfffd
    let size = 1
    if (b < 0x80) code = b
    else if (b >= 0xc2 && b < 0xe0 && i + 1 < end && (bytes[i + 1] & 0xc0) === 0x80) {
      code = ((b & 31) << 6) | (bytes[i + 1] & 63)
      size = 2
    } else if (b >= 0xe0 && b < 0xf0 && i + 2 < end && (bytes[i + 1] & 0xc0) === 0x80 && (bytes[i + 2] & 0xc0) === 0x80) {
      const c = ((b & 15) << 12) | ((bytes[i + 1] & 63) << 6) | (bytes[i + 2] & 63)
      if (c >= 0x800 && (c < 0xd800 || c > 0xdfff)) { code = c; size = 3 }
    } else if (b >= 0xf0 && b < 0xf5 && i + 3 < end && (bytes[i + 1] & 0xc0) === 0x80 && (bytes[i + 2] & 0xc0) === 0x80 && (bytes[i + 3] & 0xc0) === 0x80) {
      const c = ((b & 7) << 18) | ((bytes[i + 1] & 63) << 12) | ((bytes[i + 2] & 63) << 6) | (bytes[i + 3] & 63)
      if (c >= 0x10000 && c <= 0x10ffff) { code = c; size = 4 }
    }
    i += size
    if (code > 0xffff) {
      code -= 0x10000
      chunk.push(0xd800 + (code >> 10), 0xdc00 + (code & 1023))
    } else chunk.push(code)
    if (chunk.length >= 4096) {
      parts.push(String.fromCharCode.apply(null, chunk))
      chunk = []
    }
  }
  if (chunk.length) parts.push(String.fromCharCode.apply(null, chunk))
  return parts.join('')
}

export function latin1Encode(text) {
  const str = String(text)
  const out = new Uint8Array(str.length)
  for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 255
  return out
}

export function latin1Decode(bytes, start = 0, end = bytes.length) {
  const parts = []
  for (let i = start; i < end; i += 4096) {
    parts.push(String.fromCharCode.apply(null, bytes.subarray(i, Math.min(end, i + 4096))))
  }
  return parts.join('')
}

export function toBytes(value) {
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  if (Array.isArray(value)) return Uint8Array.from(value)
  return utf8Encode(String(value))
}
