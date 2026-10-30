import { Buffer } from '../runtime/buffer.js'
import { TextDecoder } from '../runtime/encoding.js'

export class StringDecoder {
  constructor(encoding = 'utf8') {
    this.encoding = String(encoding).toLowerCase().replace('-', '')
    this._utf8 = this.encoding === 'utf8'
    this._decoder = this._utf8 ? new TextDecoder('utf-8') : null
  }
  write(buffer) {
    if (typeof buffer === 'string') return buffer
    if (this._utf8) return this._decoder.decode(buffer, { stream: true })
    return Buffer.from(buffer).toString(this.encoding)
  }
  end(buffer) {
    let out = buffer ? this.write(buffer) : ''
    if (this._utf8) out += this._decoder.decode()
    return out
  }
}

export default { StringDecoder }
