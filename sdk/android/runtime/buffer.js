import {
  base64ToBytes,
  bytesToBase64,
  latin1Decode,
  latin1Encode,
  utf8Decode,
  utf8Encode
} from './host.js'

function normalizeEncoding(encoding) {
  const value = String(encoding || 'utf8').toLowerCase()
  switch (value) {
    case 'utf8':
    case 'utf-8':
      return 'utf8'
    case 'hex':
      return 'hex'
    case 'base64':
      return 'base64'
    case 'base64url':
      return 'base64url'
    case 'latin1':
    case 'binary':
      return 'latin1'
    case 'ascii':
      return 'ascii'
    case 'ucs2':
    case 'ucs-2':
    case 'utf16le':
    case 'utf-16le':
      return 'utf16le'
    default:
      throw new TypeError(`Unknown encoding: ${encoding}`)
  }
}

function encodeString(string, encoding) {
  const text = String(string)
  switch (normalizeEncoding(encoding)) {
    case 'utf8':
      return utf8Encode(text)
    case 'hex': {
      const length = text.length >> 1
      const out = new Uint8Array(length)
      let i = 0
      for (; i < length; i++) {
        const byte = parseInt(text.substr(i * 2, 2), 16)
        if (Number.isNaN(byte)) break
        out[i] = byte
      }
      return i === length ? out : out.subarray(0, i)
    }
    case 'base64':
    case 'base64url':
      return base64ToBytes(text)
    case 'latin1':
    case 'ascii':
      return latin1Encode(text)
    case 'utf16le': {
      const out = new Uint8Array(text.length * 2)
      for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i)
        out[i * 2] = code & 255
        out[i * 2 + 1] = code >> 8
      }
      return out
    }
  }
  return utf8Encode(text)
}

function decodeBytes(bytes, encoding, start, end) {
  switch (normalizeEncoding(encoding)) {
    case 'utf8':
      return utf8Decode(bytes, start, end)
    case 'hex': {
      let out = ''
      for (let i = start; i < end; i++) out += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16)
      return out
    }
    case 'base64':
      return bytesToBase64(bytes.subarray(start, end))
    case 'base64url':
      return bytesToBase64(bytes.subarray(start, end), true)
    case 'latin1':
      return latin1Decode(bytes, start, end)
    case 'ascii': {
      const copy = new Uint8Array(end - start)
      for (let i = start; i < end; i++) copy[i - start] = bytes[i] & 127
      return latin1Decode(copy)
    }
    case 'utf16le': {
      let out = ''
      for (let i = start; i + 1 < end; i += 2) out += String.fromCharCode(bytes[i] | (bytes[i + 1] << 8))
      return out
    }
  }
  return utf8Decode(bytes, start, end)
}

function checkOffset(buffer, offset, size) {
  const value = offset === undefined ? 0 : Number(offset)
  if (!Number.isInteger(value) || value < 0 || value + size > buffer.length) {
    throw new RangeError(`The value of "offset" is out of range. It must be >= 0 and <= ${buffer.length - size}. Received ${offset}`)
  }
  return value
}

export class Buffer extends Uint8Array {
  static from(value, encodingOrOffset, length) {
    if (typeof value === 'string') return Buffer._wrap(encodeString(value, encodingOrOffset))
    if (value instanceof ArrayBuffer) {
      const offset = encodingOrOffset === undefined ? 0 : Number(encodingOrOffset)
      const size = length === undefined ? value.byteLength - offset : Number(length)
      return new Buffer(value, offset, size)
    }
    if (ArrayBuffer.isView(value)) {
      const copy = new Buffer(value.byteLength)
      copy.set(new Uint8Array(value.buffer, value.byteOffset, value.byteLength))
      return copy
    }
    if (value && value.type === 'Buffer' && Array.isArray(value.data)) return Buffer._wrap(Uint8Array.from(value.data))
    if (Array.isArray(value) || (value && typeof value.length === 'number')) {
      const copy = new Buffer(value.length)
      for (let i = 0; i < value.length; i++) copy[i] = Number(value[i]) & 255
      return copy
    }
    if (value && typeof value[Symbol.iterator] === 'function') return Buffer.from(Array.from(value))
    throw new TypeError('The first argument must be of type string or an instance of Buffer, ArrayBuffer, or Array or an Array-like Object.')
  }

  static _wrap(bytes) {
    return new Buffer(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  }

  static alloc(size, fill, encoding) {
    const buffer = new Buffer(size)
    if (fill !== undefined && fill !== 0) buffer.fill(fill, 0, buffer.length, encoding)
    return buffer
  }

  static allocUnsafe(size) {
    return new Buffer(size)
  }

  static allocUnsafeSlow(size) {
    return new Buffer(size)
  }

  static isBuffer(value) {
    return value instanceof Buffer
  }

  static isEncoding(encoding) {
    try {
      normalizeEncoding(encoding)
      return true
    } catch {
      return false
    }
  }

  static byteLength(value, encoding) {
    if (typeof value === 'string') return encodeString(value, encoding).length
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return value.byteLength
    throw new TypeError('The "string" argument must be of type string or an instance of Buffer or ArrayBuffer.')
  }

  static concat(list, totalLength) {
    const total = totalLength === undefined ? list.reduce((sum, item) => sum + item.length, 0) : totalLength
    const out = Buffer.alloc(total)
    let offset = 0
    for (const item of list) {
      if (offset >= total) break
      const bytes = item instanceof Uint8Array ? item : new Uint8Array(item)
      const count = Math.min(bytes.length, total - offset)
      out.set(count === bytes.length ? bytes : bytes.subarray(0, count), offset)
      offset += count
    }
    return out
  }

  static compare(a, b) {
    const length = Math.min(a.length, b.length)
    for (let i = 0; i < length; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1
    return a.length === b.length ? 0 : a.length < b.length ? -1 : 1
  }

  get parent() {
    return this.buffer
  }

  toString(encoding, start = 0, end = this.length) {
    const from = Math.max(0, Math.min(this.length, Number(start) || 0))
    const to = Math.max(from, Math.min(this.length, end === undefined ? this.length : Number(end)))
    return decodeBytes(this, encoding, from, to)
  }

  toLocaleString(encoding, start, end) {
    return this.toString(encoding, start, end)
  }

  toJSON() {
    return { type: 'Buffer', data: Array.from(this) }
  }

  equals(other) {
    return Buffer.compare(this, other) === 0
  }

  compare(target, targetStart = 0, targetEnd = target.length, sourceStart = 0, sourceEnd = this.length) {
    return Buffer.compare(this.subarray(sourceStart, sourceEnd), target.subarray(targetStart, targetEnd))
  }

  copy(target, targetStart = 0, sourceStart = 0, sourceEnd = this.length) {
    const end = Math.min(sourceEnd, this.length, sourceStart + (target.length - targetStart))
    if (end <= sourceStart) return 0
    target.set(this.subarray(sourceStart, end), targetStart)
    return end - sourceStart
  }

  slice(start, end) {
    return this.subarray(start, end)
  }

  subarray(start, end) {
    const view = Uint8Array.prototype.subarray.call(this, start, end)
    return new Buffer(view.buffer, view.byteOffset, view.length)
  }

  write(string, offset, length, encoding) {
    if (typeof offset === 'string') {
      encoding = offset
      offset = 0
      length = undefined
    } else if (typeof length === 'string') {
      encoding = length
      length = undefined
    }
    const start = offset === undefined ? 0 : Number(offset)
    const bytes = encodeString(string, encoding)
    const count = Math.min(bytes.length, this.length - start, length === undefined ? Infinity : Number(length))
    this.set(bytes.subarray(0, count), start)
    return count
  }

  fill(value, offset = 0, end = this.length, encoding) {
    if (typeof offset === 'string') {
      encoding = offset
      offset = 0
      end = this.length
    }
    if (typeof value === 'string') {
      const bytes = value.length === 1 && value.charCodeAt(0) < 128 ? [value.charCodeAt(0)] : encodeString(value, encoding)
      if (!bytes.length) return this
      for (let i = offset, j = 0; i < end; i++, j = (j + 1) % bytes.length) this[i] = bytes[j]
      return this
    }
    if (value instanceof Uint8Array) {
      for (let i = offset, j = 0; i < end; i++, j = (j + 1) % value.length) this[i] = value[j]
      return this
    }
    return Uint8Array.prototype.fill.call(this, Number(value) & 255, offset, end)
  }

  indexOf(value, byteOffset = 0, encoding) {
    if (typeof value === 'number') return Uint8Array.prototype.indexOf.call(this, value & 255, byteOffset)
    const needle = typeof value === 'string' ? encodeString(value, encoding) : value
    if (!needle.length) return byteOffset <= this.length ? byteOffset : this.length
    outer: for (let i = Math.max(0, byteOffset); i <= this.length - needle.length; i++) {
      for (let j = 0; j < needle.length; j++) if (this[i + j] !== needle[j]) continue outer
      return i
    }
    return -1
  }

  includes(value, byteOffset, encoding) {
    return this.indexOf(value, byteOffset, encoding) !== -1
  }

  readUInt8(offset) { return this[checkOffset(this, offset, 1)] }
  readInt8(offset) { const v = this.readUInt8(offset); return v & 0x80 ? v - 0x100 : v }
  readUInt16LE(offset) { const o = checkOffset(this, offset, 2); return this[o] | (this[o + 1] << 8) }
  readUInt16BE(offset) { const o = checkOffset(this, offset, 2); return (this[o] << 8) | this[o + 1] }
  readInt16LE(offset) { const v = this.readUInt16LE(offset); return v & 0x8000 ? v - 0x10000 : v }
  readInt16BE(offset) { const v = this.readUInt16BE(offset); return v & 0x8000 ? v - 0x10000 : v }
  readUInt32LE(offset) { const o = checkOffset(this, offset, 4); return (this[o] | (this[o + 1] << 8) | (this[o + 2] << 16)) + this[o + 3] * 0x1000000 }
  readUInt32BE(offset) { const o = checkOffset(this, offset, 4); return this[o] * 0x1000000 + ((this[o + 1] << 16) | (this[o + 2] << 8) | this[o + 3]) }
  readInt32LE(offset) { const o = checkOffset(this, offset, 4); return this[o] | (this[o + 1] << 8) | (this[o + 2] << 16) | (this[o + 3] << 24) }
  readInt32BE(offset) { const o = checkOffset(this, offset, 4); return (this[o] << 24) | (this[o + 1] << 16) | (this[o + 2] << 8) | this[o + 3] }
  readFloatLE(offset) { return this._view().getFloat32(checkOffset(this, offset, 4), true) }
  readFloatBE(offset) { return this._view().getFloat32(checkOffset(this, offset, 4), false) }
  readDoubleLE(offset) { return this._view().getFloat64(checkOffset(this, offset, 8), true) }
  readDoubleBE(offset) { return this._view().getFloat64(checkOffset(this, offset, 8), false) }
  readBigUInt64LE(offset) { return this._view().getBigUint64(checkOffset(this, offset, 8), true) }
  readBigUInt64BE(offset) { return this._view().getBigUint64(checkOffset(this, offset, 8), false) }

  writeUInt8(value, offset) { const o = checkOffset(this, offset, 1); this[o] = value & 255; return o + 1 }
  writeInt8(value, offset) { return this.writeUInt8(value < 0 ? value + 0x100 : value, offset) }
  writeUInt16LE(value, offset) { const o = checkOffset(this, offset, 2); this[o] = value & 255; this[o + 1] = (value >>> 8) & 255; return o + 2 }
  writeUInt16BE(value, offset) { const o = checkOffset(this, offset, 2); this[o] = (value >>> 8) & 255; this[o + 1] = value & 255; return o + 2 }
  writeInt16LE(value, offset) { return this.writeUInt16LE(value & 0xffff, offset) }
  writeInt16BE(value, offset) { return this.writeUInt16BE(value & 0xffff, offset) }
  writeUInt32LE(value, offset) { const o = checkOffset(this, offset, 4); this._view().setUint32(o, value >>> 0, true); return o + 4 }
  writeUInt32BE(value, offset) { const o = checkOffset(this, offset, 4); this._view().setUint32(o, value >>> 0, false); return o + 4 }
  writeInt32LE(value, offset) { const o = checkOffset(this, offset, 4); this._view().setInt32(o, value | 0, true); return o + 4 }
  writeInt32BE(value, offset) { const o = checkOffset(this, offset, 4); this._view().setInt32(o, value | 0, false); return o + 4 }
  writeFloatLE(value, offset) { const o = checkOffset(this, offset, 4); this._view().setFloat32(o, value, true); return o + 4 }
  writeFloatBE(value, offset) { const o = checkOffset(this, offset, 4); this._view().setFloat32(o, value, false); return o + 4 }
  writeDoubleLE(value, offset) { const o = checkOffset(this, offset, 8); this._view().setFloat64(o, value, true); return o + 8 }
  writeDoubleBE(value, offset) { const o = checkOffset(this, offset, 8); this._view().setFloat64(o, value, false); return o + 8 }

  readUIntBE(offset, byteLength) {
    const o = checkOffset(this, offset, byteLength)
    let value = 0
    for (let i = 0; i < byteLength; i++) value = value * 256 + this[o + i]
    return value
  }

  readUIntLE(offset, byteLength) {
    const o = checkOffset(this, offset, byteLength)
    let value = 0
    for (let i = byteLength - 1; i >= 0; i--) value = value * 256 + this[o + i]
    return value
  }

  writeUIntBE(value, offset, byteLength) {
    const o = checkOffset(this, offset, byteLength)
    let rest = value
    for (let i = byteLength - 1; i >= 0; i--) {
      this[o + i] = rest & 255
      rest = Math.floor(rest / 256)
    }
    return o + byteLength
  }

  writeUIntLE(value, offset, byteLength) {
    const o = checkOffset(this, offset, byteLength)
    let rest = value
    for (let i = 0; i < byteLength; i++) {
      this[o + i] = rest & 255
      rest = Math.floor(rest / 256)
    }
    return o + byteLength
  }

  swap16() {
    for (let i = 0; i + 1 < this.length; i += 2) {
      const a = this[i]
      this[i] = this[i + 1]
      this[i + 1] = a
    }
    return this
  }

  _view() {
    return new DataView(this.buffer, this.byteOffset, this.byteLength)
  }
}

// Node's lower-case aliases.
for (const name of Object.getOwnPropertyNames(Buffer.prototype)) {
  if (/^(read|write)U?Int/.test(name) && name.includes('UInt')) {
    const alias = name.replace('UInt', 'Uint')
    if (!(alias in Buffer.prototype)) Buffer.prototype[alias] = Buffer.prototype[name]
  }
}

export const kMaxLength = 0x7fffffff
export const constants = { MAX_LENGTH: kMaxLength, MAX_STRING_LENGTH: 0x1fffffe8 }
