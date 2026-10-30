import { EventEmitter } from './events.js'
import { Readable, Writable } from './stream.js'
import { Buffer } from '../runtime/buffer.js'
import { fetch, ReadableStream, Response, virtualServers } from '../runtime/fetch.js'
import { AbortController } from '../runtime/events.js'
import { TwilightPromise as Promise, clearTimeout, queueMicrotask, setTimeout } from '../runtime/loop.js'
import { URL } from '../runtime/url.js'

// node:http. Servers never bind a real socket: listen() registers the server
// in the loopback table and fetch() to 127.0.0.1:<port> is dispatched to it
// inside the plugin VM. Client requests are carried by fetch().

export const STATUS_CODES = {
  100: 'Continue', 101: 'Switching Protocols', 200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No Content',
  206: 'Partial Content', 301: 'Moved Permanently', 302: 'Found', 303: 'See Other', 304: 'Not Modified',
  307: 'Temporary Redirect', 308: 'Permanent Redirect', 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden',
  404: 'Not Found', 405: 'Method Not Allowed', 408: 'Request Timeout', 409: 'Conflict', 410: 'Gone',
  413: 'Payload Too Large', 416: 'Range Not Satisfiable', 429: 'Too Many Requests', 499: 'Client Closed Request',
  500: 'Internal Server Error', 501: 'Not Implemented', 502: 'Bad Gateway', 503: 'Service Unavailable',
  504: 'Gateway Timeout'
}

export const METHODS = ['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT']

let nextPort = 41000

function fakeSocket() {
  const socket = new EventEmitter()
  socket.remoteAddress = '127.0.0.1'
  socket.remotePort = 0
  socket.remoteFamily = 'IPv4'
  socket.localAddress = '127.0.0.1'
  socket.localPort = 0
  socket.encrypted = false
  socket.readable = true
  socket.writable = true
  socket.destroyed = false
  socket.setTimeout = () => socket
  socket.setNoDelay = () => socket
  socket.setKeepAlive = () => socket
  socket.ref = () => socket
  socket.unref = () => socket
  socket.address = () => ({ address: '127.0.0.1', family: 'IPv4', port: 0 })
  socket.end = () => socket
  socket.destroy = () => {
    socket.destroyed = true
    return socket
  }
  return socket
}

function headerObject(pairs) {
  const headers = {}
  const raw = []
  for (const [name, value] of pairs) {
    const key = String(name).toLowerCase()
    raw.push(name, value)
    if (key === 'set-cookie') (headers[key] = headers[key] || []).push(value)
    else if (key in headers) headers[key] += ', ' + value
    else headers[key] = value
  }
  return { headers, raw }
}

class OutgoingHeaders extends Writable {
  constructor() {
    super()
    this._headerMap = new Map()
  }
  setHeader(name, value) {
    this._headerMap.set(String(name).toLowerCase(), [String(name), value])
    return this
  }
  appendHeader(name, value) {
    const current = this.getHeader(name)
    if (current === undefined) return this.setHeader(name, value)
    return this.setHeader(name, [].concat(current, value))
  }
  getHeader(name) {
    const entry = this._headerMap.get(String(name).toLowerCase())
    return entry ? entry[1] : undefined
  }
  getHeaders() {
    const out = Object.create(null)
    for (const [key, entry] of this._headerMap) out[key] = entry[1]
    return out
  }
  getHeaderNames() {
    return Array.from(this._headerMap.keys())
  }
  hasHeader(name) {
    return this._headerMap.has(String(name).toLowerCase())
  }
  removeHeader(name) {
    this._headerMap.delete(String(name).toLowerCase())
  }
  _headerPairs() {
    const pairs = []
    for (const [, [name, value]] of this._headerMap) {
      if (Array.isArray(value)) for (const item of value) pairs.push([name, String(item)])
      else if (value !== undefined) pairs.push([name, String(value)])
    }
    return pairs
  }
}

export class IncomingMessage extends Readable {
  constructor(socket) {
    super()
    this.socket = socket || fakeSocket()
    this.connection = this.socket
    this.headers = {}
    this.rawHeaders = []
    this.trailers = {}
    this.rawTrailers = []
    this.method = null
    this.url = ''
    this.statusCode = null
    this.statusMessage = null
    this.httpVersion = '1.1'
    this.httpVersionMajor = 1
    this.httpVersionMinor = 1
    this.complete = false
    this.aborted = false
  }
  setTimeout(ms, callback) {
    if (callback) this.once('timeout', callback)
    return this
  }
}

export class ServerResponse extends OutgoingHeaders {
  constructor(req) {
    super()
    this.req = req
    this.socket = req.socket
    this.connection = this.socket
    this.statusCode = 200
    this.statusMessage = ''
    this.headersSent = false
    this.finished = false
    this.sendDate = true
    this.chunkedEncoding = false
    this._sink = null
  }
  writeHead(status, message, headers) {
    if (typeof message === 'object' && message !== null) {
      headers = message
      message = undefined
    }
    this.statusCode = Number(status)
    if (typeof message === 'string') this.statusMessage = message
    if (Array.isArray(headers)) {
      if (headers.length && Array.isArray(headers[0])) for (const [name, value] of headers) this.appendHeader(name, value)
      else for (let i = 0; i + 1 < headers.length; i += 2) this.appendHeader(headers[i], headers[i + 1])
    } else if (headers) {
      for (const name of Object.keys(headers)) if (headers[name] !== undefined) this.setHeader(name, headers[name])
    }
    this._sendHead()
    return this
  }
  flushHeaders() {
    this._sendHead()
  }
  writeContinue() {}
  writeProcessing() {}
  setTimeout() {
    return this
  }
  assignSocket() {}
  detachSocket() {}
  _sendHead() {
    if (this.headersSent) return
    this.headersSent = true
    this._sink.head(this.statusCode, this.statusMessage || STATUS_CODES[this.statusCode] || '', this._headerPairs())
  }
  _write(chunk, encoding, callback) {
    this._sendHead()
    if (chunk.length) this._sink.chunk(chunk)
    callback()
  }
  _final(callback) {
    this._sendHead()
    this.finished = true
    this._sink.end()
    callback()
  }
  destroy(error) {
    if (!this.destroyed && !this.finished) this._sink.abort(error)
    return super.destroy(error)
  }
}

function networkError(message, code) {
  const cause = Object.assign(new Error(message), code ? { code } : {})
  return Object.assign(new TypeError('fetch failed'), { cause })
}

export class Server extends EventEmitter {
  constructor(options, handler) {
    super()
    if (typeof options === 'function') handler = options
    if (handler) this.on('request', handler)
    this.listening = false
    this._port = 0
    this.timeout = 0
    this.keepAliveTimeout = 5000
    this.headersTimeout = 60000
    this.requestTimeout = 300000
    this.maxHeadersCount = null
  }
  listen(...args) {
    let port = null
    let callback = null
    for (const arg of args) {
      if (typeof arg === 'function') callback = arg
      else if (port === null && (typeof arg === 'number' || (typeof arg === 'string' && /^\d+$/.test(arg)))) port = Number(arg)
      else if (arg && typeof arg === 'object' && port === null) port = Number(arg.port || 0)
    }
    if (callback) this.once('listening', callback)
    if (port && virtualServers.has(port)) {
      const error = Object.assign(new Error(`listen EADDRINUSE: address already in use 127.0.0.1:${port}`), { code: 'EADDRINUSE' })
      queueMicrotask(() => this.emit('error', error))
      return this
    }
    if (!port) {
      while (virtualServers.has(nextPort)) nextPort++
      port = nextPort++
    }
    this._port = port
    virtualServers.set(port, this)
    this.listening = true
    queueMicrotask(() => this.emit('listening'))
    return this
  }
  address() {
    return this.listening ? { address: '127.0.0.1', family: 'IPv4', port: this._port } : null
  }
  close(callback) {
    if (this.listening) {
      virtualServers.delete(this._port)
      this.listening = false
    }
    queueMicrotask(() => {
      this.emit('close')
      if (callback) callback()
    })
    return this
  }
  closeAllConnections() {}
  closeIdleConnections() {}
  setTimeout(ms, callback) {
    if (callback) this.on('timeout', callback)
    return this
  }
  ref() {
    return this
  }
  unref() {
    return this
  }
  getConnections(callback) {
    if (callback) queueMicrotask(() => callback(null, 0))
  }

  /** Called by fetch() for http://127.0.0.1:<port>/… requests. */
  _dispatch(request, payload) {
    return new Promise((resolve, reject) => {
      const url = new URL(request.url)
      const req = new IncomingMessage()
      req.method = request.method
      req.url = url.pathname + url.search
      const parsed = headerObject(request.headers._pairs())
      req.headers = parsed.headers
      req.rawHeaders = parsed.raw
      if (!req.headers.host) req.headers.host = url.host
      const res = new ServerResponse(req)
      let controller = null
      let settled = false
      const body = new ReadableStream({
        start(c) {
          controller = c
        },
        cancel() {
          if (!res.finished) {
            req.aborted = true
            req.emit('aborted')
            res.emit('close')
          }
        }
      })
      res._sink = {
        head(status, statusText, pairs) {
          settled = true
          const response = new Response(null, { status, statusText, headers: pairs, url: request.url, type: 'basic', _internal: true })
          if (request.method === 'HEAD' || status === 204 || status === 304) response._bodyKind = 'none'
          else {
            response._bodyKind = 'stream'
            response._bodyStream = body
          }
          resolve(response)
        },
        chunk(chunk) {
          controller.enqueue(new Uint8Array(chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength)))
        },
        end() {
          req.complete = true
          controller.close()
        },
        abort(error) {
          const failure = error || networkError('socket hang up', 'ECONNRESET')
          if (!settled) {
            settled = true
            reject(networkError(failure.message || 'socket hang up', 'ECONNRESET'))
          } else controller.error(failure)
        }
      }
      const signal = request.signal
      if (signal && typeof signal.addEventListener === 'function') {
        signal.addEventListener(
          'abort',
          () => {
            if (res.finished) return
            req.aborted = true
            req.emit('aborted')
            req.destroy()
            res.emit('close')
          },
          { once: true }
        )
      }
      if (payload) req.push(payload.text !== undefined ? Buffer.from(payload.text, 'utf8') : Buffer.from(payload.bytes))
      req.push(null)
      try {
        this.emit('request', req, res)
      } catch (error) {
        if (!settled) {
          settled = true
          reject(error)
        }
      }
    })
  }
}

export function createServer(options, handler) {
  return new Server(options, handler)
}

export class Agent extends EventEmitter {
  constructor(options = {}) {
    super()
    this.options = options
    this.keepAlive = Boolean(options.keepAlive)
    this.maxSockets = options.maxSockets || Infinity
    this.sockets = {}
    this.requests = {}
    this.freeSockets = {}
  }
  destroy() {}
}

export const globalAgent = new Agent()

export class ClientRequest extends OutgoingHeaders {
  constructor(input, options, callback, defaultProtocol) {
    super()
    if (typeof options === 'function') {
      callback = options
      options = {}
    }
    let target = {}
    if (typeof input === 'string' || input instanceof URL) {
      const url = new URL(String(input))
      target = { protocol: url.protocol, hostname: url.hostname, port: url.port, path: url.pathname + url.search }
      if (url.username) target.auth = decodeURIComponent(url.username) + ':' + decodeURIComponent(url.password)
      options = { ...target, ...(options || {}) }
    } else options = { ...(input || {}), ...(options || {}) }
    this.protocol = options.protocol || defaultProtocol
    this.host = options.hostname || (options.host ? String(options.host).replace(/:\d+$/, '') : 'localhost')
    this.port = options.port ? String(options.port) : ''
    this.method = String(options.method || 'GET').toUpperCase()
    this.path = options.path || '/'
    this.aborted = false
    this.reusedSocket = false
    this.socket = fakeSocket()
    this.connection = this.socket
    this._chunks = []
    this._controller = new AbortController()
    this._timer = null
    const headers = options.headers || {}
    if (Array.isArray(headers)) for (let i = 0; i + 1 < headers.length; i += 2) this.appendHeader(headers[i], headers[i + 1])
    else for (const name of Object.keys(headers)) if (headers[name] !== undefined) this.setHeader(name, headers[name])
    if (options.auth && !this.hasHeader('authorization')) this.setHeader('Authorization', 'Basic ' + Buffer.from(options.auth).toString('base64'))
    if (callback) this.once('response', callback)
    if (options.timeout) this.setTimeout(options.timeout)
    if (options.signal) {
      const signal = options.signal
      if (signal.aborted) queueMicrotask(() => this.destroy(signal.reason))
      else signal.addEventListener('abort', () => this.destroy(signal.reason), { once: true })
    }
    queueMicrotask(() => this.emit('socket', this.socket))
  }
  setTimeout(ms, callback) {
    if (callback) this.once('timeout', callback)
    clearTimeout(this._timer)
    if (ms > 0) this._timer = setTimeout(() => this.emit('timeout'), ms)
    return this
  }
  setNoDelay() {}
  setSocketKeepAlive() {}
  flushHeaders() {}
  getRawHeaderNames() {
    return Array.from(this._headerMap.values()).map(([name]) => name)
  }
  _write(chunk, encoding, callback) {
    this._chunks.push(chunk)
    callback()
  }
  _final(callback) {
    callback()
    this._send()
  }
  abort() {
    this.destroy()
  }
  destroy(error) {
    if (this.destroyed) return this
    this.aborted = true
    clearTimeout(this._timer)
    this._controller.abort(error)
    if (this._response && !this._response.complete) this._response.destroy(error)
    return super.destroy(error)
  }
  _send() {
    const defaultPort = this.protocol === 'https:' ? '443' : '80'
    const port = this.port && this.port !== defaultPort ? ':' + this.port : ''
    const host = this.host.indexOf(':') >= 0 && !this.host.startsWith('[') ? `[${this.host}]` : this.host
    const url = `${this.protocol}//${host}${port}${this.path}`
    const body = this._chunks.length ? Buffer.concat(this._chunks) : undefined
    const init = { method: this.method, headers: this._headerPairs(), redirect: 'manual', signal: this._controller.signal }
    if (body && this.method !== 'GET' && this.method !== 'HEAD') init.body = body
    fetch(url, init).then(
      (response) => {
        clearTimeout(this._timer)
        const res = new IncomingMessage(this.socket)
        const parsed = headerObject(Array.from(response.headers._pairs()))
        res.statusCode = response.status
        res.statusMessage = response.statusText || STATUS_CODES[response.status] || ''
        res.headers = parsed.headers
        res.rawHeaders = parsed.raw
        res.req = this
        this._response = res
        this.emit('response', res)
        if (!response.body) {
          res.complete = true
          res.push(null)
          return
        }
        const reader = response.body.getReader()
        const pump = () =>
          reader.read().then(
            ({ value, done }) => {
              if (done) {
                res.complete = true
                res.push(null)
                this.emit('close')
                return
              }
              res.push(Buffer.from(value))
              pump()
            },
            (error) => res.destroy(error)
          )
        pump()
      },
      (error) => {
        clearTimeout(this._timer)
        if (this.aborted) return
        const cause = error && error.cause ? error.cause : error
        const failure = Object.assign(new Error(cause && cause.message ? cause.message : String(error)), {
          code: (cause && cause.code) || 'ECONNRESET'
        })
        this.emit('error', failure)
      }
    )
  }
}

export function request(input, options, callback) {
  return new ClientRequest(input, options, callback, 'http:')
}

export function get(input, options, callback) {
  const req = request(input, options, callback)
  req.end()
  return req
}

export const maxHeaderSize = 16384

export function validateHeaderName(name) {
  if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(String(name))) throw new TypeError(`Header name must be a valid HTTP token ["${name}"]`)
}

export function validateHeaderValue(name, value) {
  if (/[\0\r\n]/.test(String(value))) throw new TypeError(`Invalid character in header content ["${name}"]`)
}

export const OutgoingMessage = OutgoingHeaders

export default {
  STATUS_CODES,
  METHODS,
  Agent,
  globalAgent,
  ClientRequest,
  IncomingMessage,
  OutgoingMessage,
  Server,
  ServerResponse,
  createServer,
  request,
  get,
  maxHeaderSize,
  validateHeaderName,
  validateHeaderValue
}
