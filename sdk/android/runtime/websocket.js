import { base64ToBytes, bytesToBase64, hostCall, toBytes } from './host.js'
import { CloseEvent, DOMException, Event, EventTarget, MessageEvent } from './events.js'
import { queueMacrotask, registerIoSource } from './loop.js'
import { URL } from './url.js'
import { Blob } from './fetch.js'

// WHATWG WebSocket over the host's OkHttp sockets. Frames received while no
// plugin call is running are queued host-side and delivered by the next pump.
export class WebSocket extends EventTarget {
  constructor(url, protocols, options) {
    super()
    const parsed = new URL(url instanceof URL ? url.href : String(url))
    if (parsed.protocol === 'http:') parsed.protocol = 'ws:'
    if (parsed.protocol === 'https:') parsed.protocol = 'wss:'
    if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
      throw new DOMException(`The URL's scheme must be either 'ws' or 'wss'.`, 'SyntaxError')
    }
    this.url = parsed.href
    this.readyState = WebSocket.CONNECTING
    this.protocol = ''
    this.extensions = ''
    this.bufferedAmount = 0
    this.binaryType = 'blob'
    this.onopen = null
    this.onmessage = null
    this.onerror = null
    this.onclose = null
    this.ioId = null
    this._unregister = null
    const list = protocols === undefined ? [] : Array.isArray(protocols) ? protocols : [protocols]
    const headers = options && typeof options === 'object' && options.headers ? Object.entries(options.headers) : []
    queueMacrotask(() => this._open(list.map(String), headers))
  }

  _open(protocols, headers) {
    if (this.readyState !== WebSocket.CONNECTING) return
    try {
      const reply = hostCall('ws.open', { url: this.url, protocols, headers })
      this.ioId = reply.id
      this._unregister = registerIoSource(this)
    } catch (error) {
      this._finish(1006, error && error.message ? error.message : '', true)
    }
  }

  deliver(event) {
    switch (event.type) {
      case 'open':
        if (this.readyState !== WebSocket.CONNECTING) return
        this.readyState = WebSocket.OPEN
        this.protocol = event.protocol || ''
        this.dispatchEvent(new Event('open'))
        return
      case 'message': {
        if (this.readyState !== WebSocket.OPEN) return
        let data = event.text
        if (event.binary !== undefined) {
          const bytes = base64ToBytes(event.binary)
          data = this.binaryType === 'arraybuffer' ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) : new Blob([bytes])
        }
        this.dispatchEvent(new MessageEvent('message', { data, origin: new URL(this.url).origin }))
        return
      }
      case 'error':
        this.dispatchEvent(new Event('error'))
        return
      case 'close':
        this._finish(event.code || 1006, event.reason || '', event.code === undefined || event.code === 1006)
        return
    }
  }

  _finish(code, reason, failed) {
    if (this.readyState === WebSocket.CLOSED) return
    this.readyState = WebSocket.CLOSED
    if (this._unregister) this._unregister()
    this._unregister = null
    if (failed) this.dispatchEvent(new Event('error'))
    this.dispatchEvent(new CloseEvent('close', { code, reason, wasClean: !failed }))
  }

  send(data) {
    if (this.readyState === WebSocket.CONNECTING) throw new DOMException('Still in CONNECTING state.', 'InvalidStateError')
    if (this.readyState !== WebSocket.OPEN) return
    if (typeof data === 'string') hostCall('ws.send', { id: this.ioId, text: data })
    else if (data instanceof Blob) hostCall('ws.send', { id: this.ioId, binary: bytesToBase64(data._bytes) })
    else hostCall('ws.send', { id: this.ioId, binary: bytesToBase64(toBytes(data)) })
  }

  close(code, reason) {
    if (this.readyState === WebSocket.CLOSING || this.readyState === WebSocket.CLOSED) return
    const wasConnecting = this.ioId === null
    this.readyState = WebSocket.CLOSING
    if (wasConnecting) {
      queueMacrotask(() => this._finish(1006, '', true))
      return
    }
    try {
      hostCall('ws.close', { id: this.ioId, code: code === undefined ? 1000 : Number(code), reason: reason === undefined ? '' : String(reason) })
    } catch {
      queueMacrotask(() => this._finish(1006, '', true))
    }
  }
}

WebSocket.CONNECTING = 0
WebSocket.OPEN = 1
WebSocket.CLOSING = 2
WebSocket.CLOSED = 3
