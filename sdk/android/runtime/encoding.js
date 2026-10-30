import { utf8Decode, utf8Encode, latin1Decode, toBytes } from './host.js'

export class TextEncoder {
  get encoding() {
    return 'utf-8'
  }
  encode(input = '') {
    return utf8Encode(String(input))
  }
  encodeInto(input, destination) {
    const bytes = utf8Encode(String(input))
    const written = Math.min(bytes.length, destination.length)
    destination.set(bytes.subarray(0, written))
    return { read: String(input).length, written }
  }
}

const UTF8_LABELS = new Set(['utf-8', 'utf8', 'unicode-1-1-utf-8'])
const UTF16_LABELS = new Set(['utf-16le', 'utf-16', 'ucs-2', 'utf16le'])
const LATIN1_LABELS = new Set(['latin1', 'iso-8859-1', 'ascii', 'us-ascii', 'windows-1252'])

export class TextDecoder {
  constructor(label = 'utf-8', options = {}) {
    const normalized = String(label).trim().toLowerCase()
    if (UTF8_LABELS.has(normalized)) this._encoding = 'utf-8'
    else if (UTF16_LABELS.has(normalized)) this._encoding = 'utf-16le'
    else if (LATIN1_LABELS.has(normalized)) this._encoding = 'windows-1252'
    else throw new RangeError(`The "${label}" encoding is not supported`)
    this._fatal = Boolean(options.fatal)
    this._ignoreBOM = Boolean(options.ignoreBOM)
    this._pending = null
  }
  get encoding() {
    return this._encoding
  }
  get fatal() {
    return this._fatal
  }
  get ignoreBOM() {
    return this._ignoreBOM
  }
  decode(input, options = {}) {
    let bytes = input === undefined ? new Uint8Array(0) : toBytes(input)
    if (this._pending) {
      const merged = new Uint8Array(this._pending.length + bytes.length)
      merged.set(this._pending)
      merged.set(bytes, this._pending.length)
      bytes = merged
      this._pending = null
    }
    if (this._encoding === 'utf-8') {
      let end = bytes.length
      if (options.stream) {
        // Keep an incomplete trailing sequence for the next chunk.
        let back = 0
        while (back < 3 && end - back - 1 >= 0 && (bytes[end - back - 1] & 0xc0) === 0x80) back++
        const lead = end - back - 1
        if (lead >= 0) {
          const b = bytes[lead]
          const need = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1
          if (need > back + 1) {
            this._pending = bytes.slice(lead)
            end = lead
          }
        }
      }
      let start = 0
      if (!this._ignoreBOM && end >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) start = 3
      const text = utf8Decode(bytes, start, end)
      if (this._fatal && text.indexOf('�') >= 0) throw new TypeError('The encoded data was not valid utf-8')
      return text
    }
    if (this._encoding === 'utf-16le') {
      let end = bytes.length - (bytes.length % 2)
      if (options.stream && end < bytes.length) this._pending = bytes.slice(end)
      const codes = []
      const parts = []
      for (let i = 0; i < end; i += 2) {
        codes.push(bytes[i] | (bytes[i + 1] << 8))
        if (codes.length >= 4096) {
          parts.push(String.fromCharCode.apply(null, codes))
          codes.length = 0
        }
      }
      if (codes.length) parts.push(String.fromCharCode.apply(null, codes))
      const text = parts.join('')
      return !this._ignoreBOM && text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
    }
    return latin1Decode(bytes)
  }
}

const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

export function btoa(input) {
  const str = String(input)
  let out = ''
  for (let i = 0; i < str.length; i += 3) {
    const a = str.charCodeAt(i)
    const b = str.charCodeAt(i + 1)
    const c = str.charCodeAt(i + 2)
    if (a > 255 || b > 255 || c > 255) {
      throw new Error('The string to be encoded contains characters outside of the Latin1 range.')
    }
    const n = (a << 16) | ((b || 0) << 8) | (c || 0)
    out += B64_CHARS[n >> 18] + B64_CHARS[(n >> 12) & 63]
    out += i + 1 < str.length ? B64_CHARS[(n >> 6) & 63] : '='
    out += i + 2 < str.length ? B64_CHARS[n & 63] : '='
  }
  return out
}

export function atob(input) {
  const clean = String(input).replace(/[\t\n\f\r ]+/g, '')
  if (clean.length % 4 === 1 || /[^A-Za-z0-9+/=]/.test(clean)) {
    throw new Error('The string to be decoded is not correctly encoded.')
  }
  const stripped = clean.replace(/=+$/, '')
  let out = ''
  let buffer = 0
  let bits = 0
  for (let i = 0; i < stripped.length; i++) {
    buffer = (buffer << 6) | B64_CHARS.indexOf(stripped[i])
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out += String.fromCharCode((buffer >> bits) & 255)
    }
  }
  return out
}
