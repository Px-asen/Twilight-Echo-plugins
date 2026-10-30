import { base64ToBytes, bytesToBase64, hostCall, toBytes, utf8Decode, utf8Encode } from './host.js'
import { TwilightPromise as Promise, queueMacrotask } from './loop.js'
import { URL, URLSearchParams } from './url.js'
import { DOMException } from './events.js'

// ── Headers ────────────────────────────────────────────────────────────────
function headerName(name) {
  const value = String(name).toLowerCase()
  if (!value || /[^!#$%&'*+\-.^_`|~0-9a-z]/.test(value)) throw new TypeError(`Invalid header name: ${name}`)
  return value
}

function headerValue(value) {
  const text = String(value).replace(/^[\t\n\r ]+|[\t\n\r ]+$/g, '')
  if (/[\0\r\n]/.test(text)) throw new TypeError('Invalid header value')
  return text
}

export class Headers {
  constructor(init) {
    this._map = new Map()
    if (init === undefined || init === null) return
    if (init instanceof Headers) {
      for (const [name, value] of init._pairs()) this.append(name, value)
    } else if (typeof init[Symbol.iterator] === 'function') {
      for (const pair of init) {
        const entry = Array.from(pair)
        if (entry.length !== 2) throw new TypeError('Header pairs must contain exactly two items')
        this.append(entry[0], entry[1])
      }
    } else if (typeof init === 'object') {
      for (const name of Object.keys(init)) {
        const value = init[name]
        if (value === undefined) continue
        if (Array.isArray(value)) value.forEach((item) => this.append(name, item))
        else this.append(name, value)
      }
    }
  }
  append(name, value) {
    const key = headerName(name)
    const list = this._map.get(key) || []
    list.push(headerValue(value))
    this._map.set(key, list)
  }
  set(name, value) {
    this._map.set(headerName(name), [headerValue(value)])
  }
  get(name) {
    const list = this._map.get(String(name).toLowerCase())
    return list ? list.join(', ') : null
  }
  getSetCookie() {
    return (this._map.get('set-cookie') || []).slice()
  }
  has(name) {
    return this._map.has(String(name).toLowerCase())
  }
  delete(name) {
    this._map.delete(String(name).toLowerCase())
  }
  forEach(callback, thisArg) {
    for (const [name, value] of this.entries()) callback.call(thisArg, value, name, this)
  }
  *entries() {
    for (const name of Array.from(this._map.keys()).sort()) {
      const list = this._map.get(name)
      if (name === 'set-cookie') for (const value of list) yield [name, value]
      else yield [name, list.join(', ')]
    }
  }
  *keys() {
    for (const [name] of this.entries()) yield name
  }
  *values() {
    for (const [, value] of this.entries()) yield value
  }
  [Symbol.iterator]() {
    return this.entries()
  }
  _pairs() {
    const out = []
    for (const [name, list] of this._map) for (const value of list) out.push([name, value])
    return out
  }
  _object() {
    const out = {}
    for (const [name, value] of this.entries()) out[name] = name in out ? out[name] + ', ' + value : value
    return out
  }
}

// ── Blob / File / FormData ─────────────────────────────────────────────────
function concatBytes(chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

export class Blob {
  constructor(parts = [], options = {}) {
    const chunks = []
    for (const part of parts) {
      if (part instanceof Blob) chunks.push(part._bytes)
      else if (typeof part === 'string') chunks.push(utf8Encode(part))
      else chunks.push(toBytes(part).slice())
    }
    this._bytes = concatBytes(chunks)
    this.type = String(options.type || '').toLowerCase()
  }
  get size() {
    return this._bytes.length
  }
  arrayBuffer() {
    return Promise.resolve(this._bytes.slice().buffer)
  }
  bytes() {
    return Promise.resolve(this._bytes.slice())
  }
  text() {
    return Promise.resolve(utf8Decode(this._bytes))
  }
  slice(start = 0, end = this._bytes.length, type = '') {
    const blob = new Blob([], { type })
    blob._bytes = this._bytes.slice(start, end)
    return blob
  }
  stream() {
    return streamFromBytes(this._bytes)
  }
}

export class File extends Blob {
  constructor(parts, name, options = {}) {
    super(parts, options)
    this.name = String(name)
    this.lastModified = options.lastModified || Date.now()
  }
}

export class FormData {
  constructor() {
    this._entries = []
  }
  append(name, value, filename) {
    this._entries.push([String(name), normalizeFormValue(value, filename)])
  }
  set(name, value, filename) {
    this.delete(name)
    this.append(name, value, filename)
  }
  get(name) {
    const entry = this._entries.find(([key]) => key === String(name))
    return entry ? entry[1] : null
  }
  getAll(name) {
    return this._entries.filter(([key]) => key === String(name)).map(([, value]) => value)
  }
  has(name) {
    return this._entries.some(([key]) => key === String(name))
  }
  delete(name) {
    this._entries = this._entries.filter(([key]) => key !== String(name))
  }
  forEach(callback, thisArg) {
    for (const [key, value] of this._entries) callback.call(thisArg, value, key, this)
  }
  *entries() {
    yield* this._entries.map(([key, value]) => [key, value])
  }
  *keys() {
    for (const [key] of this._entries) yield key
  }
  *values() {
    for (const [, value] of this._entries) yield value
  }
  [Symbol.iterator]() {
    return this.entries()
  }
}

function normalizeFormValue(value, filename) {
  if (value instanceof Blob) {
    if (value instanceof File && filename === undefined) return value
    return new File([value], filename === undefined ? 'blob' : filename, { type: value.type })
  }
  return String(value)
}

function encodeMultipart(form) {
  const boundary = '----TwilightFormBoundary' + Math.random().toString(36).slice(2) + Date.now().toString(36)
  const chunks = []
  const escape = (value) => String(value).replace(/\r/g, '%0D').replace(/\n/g, '%0A').replace(/"/g, '%22')
  for (const [name, value] of form._entries) {
    if (value instanceof File) {
      chunks.push(utf8Encode(`--${boundary}\r\nContent-Disposition: form-data; name="${escape(name)}"; filename="${escape(value.name)}"\r\nContent-Type: ${value.type || 'application/octet-stream'}\r\n\r\n`))
      chunks.push(value._bytes)
      chunks.push(utf8Encode('\r\n'))
    } else {
      chunks.push(utf8Encode(`--${boundary}\r\nContent-Disposition: form-data; name="${escape(name)}"\r\n\r\n${value}\r\n`))
    }
  }
  chunks.push(utf8Encode(`--${boundary}--\r\n`))
  return { bytes: concatBytes(chunks), contentType: `multipart/form-data; boundary=${boundary}` }
}

// ── ReadableStream (the subset fetch bodies and plugin proxies use) ────────
export class ReadableStream {
  constructor(source = {}) {
    this._source = source
    this._queue = []
    this._waiters = []
    this._closed = false
    this._error = null
    this._pulling = false
    this.locked = false
    const stream = this
    this._controller = {
      get desiredSize() {
        return stream._queue.length ? 0 : 1
      },
      enqueue(chunk) {
        if (stream._closed) return
        const waiter = stream._waiters.shift()
        if (waiter) waiter.resolve({ value: chunk, done: false })
        else stream._queue.push(chunk)
      },
      close() {
        stream._closed = true
        if (!stream._queue.length) for (const waiter of stream._waiters.splice(0)) waiter.resolve({ value: undefined, done: true })
      },
      error(error) {
        stream._error = error
        stream._closed = true
        for (const waiter of stream._waiters.splice(0)) waiter.reject(error)
      }
    }
    if (typeof source.start === 'function') {
      try {
        const started = source.start(this._controller)
        if (started && typeof started.then === 'function') started.then(undefined, (error) => this._controller.error(error))
      } catch (error) {
        this._controller.error(error)
      }
    }
  }
  static from(iterable) {
    const iterator = (iterable[Symbol.asyncIterator] || iterable[Symbol.iterator]).call(iterable)
    return new ReadableStream({
      pull(controller) {
        return Promise.resolve(iterator.next()).then((step) => {
          if (step.done) controller.close()
          else controller.enqueue(step.value)
        })
      },
      cancel(reason) {
        if (typeof iterator.return === 'function') iterator.return(reason)
      }
    })
  }
  _read() {
    if (this._queue.length) {
      const value = this._queue.shift()
      if (this._closed && !this._queue.length) for (const waiter of this._waiters.splice(0)) waiter.resolve({ value: undefined, done: true })
      return Promise.resolve({ value, done: false })
    }
    if (this._error) return Promise.reject(this._error)
    if (this._closed) return Promise.resolve({ value: undefined, done: true })
    return new Promise((resolve, reject) => {
      this._waiters.push({ resolve, reject })
      this._pull()
    })
  }
  _pull() {
    if (this._pulling || typeof this._source.pull !== 'function') return
    this._pulling = true
    Promise.resolve()
      .then(() => this._source.pull(this._controller))
      .then(
        () => {
          this._pulling = false
          if (this._waiters.length && !this._closed) this._pull()
        },
        (error) => {
          this._pulling = false
          this._controller.error(error)
        }
      )
  }
  getReader() {
    if (this.locked) throw new TypeError('ReadableStream is locked')
    this.locked = true
    const stream = this
    return {
      read: () => stream._read(),
      releaseLock() {
        stream.locked = false
      },
      cancel: (reason) => stream.cancel(reason),
      get closed() {
        return new Promise((resolve) => {
          if (stream._closed) resolve()
          else stream._waiters.push({ resolve: () => resolve(), reject: () => resolve() })
        })
      }
    }
  }
  cancel(reason) {
    if (!this._closed) {
      this._closed = true
      this._queue = []
      for (const waiter of this._waiters.splice(0)) waiter.resolve({ value: undefined, done: true })
      if (typeof this._source.cancel === 'function') {
        try {
          this._source.cancel(reason)
        } catch {
          // ignore
        }
      }
    }
    return Promise.resolve()
  }
  values() {
    return this[Symbol.asyncIterator]()
  }
  [Symbol.asyncIterator]() {
    const reader = this.getReader()
    return {
      next: () => reader.read(),
      return: (value) => {
        reader.cancel()
        reader.releaseLock()
        return Promise.resolve({ value, done: true })
      },
      [Symbol.asyncIterator]() {
        return this
      }
    }
  }
}

export function streamFromBytes(bytes) {
  let offset = 0
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close()
        return
      }
      const end = Math.min(bytes.length, offset + 65536)
      controller.enqueue(bytes.slice(offset, end))
      offset = end
      if (offset >= bytes.length) controller.close()
    }
  })
}

function readAll(stream) {
  const reader = stream.getReader()
  const chunks = []
  const next = () =>
    reader.read().then(({ value, done }) => {
      if (done) return concatBytes(chunks)
      chunks.push(typeof value === 'string' ? utf8Encode(value) : toBytes(value))
      return next()
    })
  return next()
}

// ── Body ───────────────────────────────────────────────────────────────────
function extractBody(body) {
  if (body === undefined || body === null) return { kind: 'none' }
  if (typeof body === 'string') return { kind: 'text', text: body, contentType: 'text/plain;charset=UTF-8' }
  if (body instanceof URLSearchParams) {
    return { kind: 'text', text: body.toString(), contentType: 'application/x-www-form-urlencoded;charset=UTF-8' }
  }
  if (body instanceof FormData) {
    const encoded = encodeMultipart(body)
    return { kind: 'bytes', bytes: encoded.bytes, contentType: encoded.contentType }
  }
  if (body instanceof Blob) return { kind: 'bytes', bytes: body._bytes, contentType: body.type || null }
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return { kind: 'bytes', bytes: toBytes(body).slice() }
  if (body instanceof ReadableStream) return { kind: 'stream', stream: body }
  if (typeof body[Symbol.asyncIterator] === 'function') return { kind: 'stream', stream: ReadableStream.from(body) }
  return { kind: 'text', text: String(body), contentType: 'text/plain;charset=UTF-8' }
}

class Body {
  _initBody(body) {
    const extracted = extractBody(body)
    this._bodyKind = extracted.kind
    this._bodyText = extracted.text === undefined ? null : extracted.text
    this._bodyBytes = extracted.bytes || null
    this._bodyStream = extracted.stream || null
    this.bodyUsed = false
    return extracted
  }
  _setText(text) {
    this._bodyKind = 'text'
    this._bodyText = text
    this._bodyBytes = null
    this._bodyStream = null
  }
  _setBytes(bytes) {
    this._bodyKind = 'bytes'
    this._bodyText = null
    this._bodyBytes = bytes
    this._bodyStream = null
  }
  get body() {
    if (this._bodyKind === 'none') return null
    if (!this._bodyStream) {
      const bytes = this._bodyBytes || utf8Encode(this._bodyText || '')
      this._bodyStream = streamFromBytes(bytes)
      this._bodyKind = 'stream'
    }
    return this._bodyStream
  }
  _consumeBytes() {
    if (this.bodyUsed) return Promise.reject(new TypeError('Body is unusable: Body has already been read'))
    this.bodyUsed = true
    if (this._bodyKind === 'none') return Promise.resolve(new Uint8Array(0))
    if (this._bodyKind === 'text') return Promise.resolve(utf8Encode(this._bodyText))
    if (this._bodyKind === 'bytes') return Promise.resolve(this._bodyBytes)
    return readAll(this._bodyStream)
  }
  text() {
    if (!this.bodyUsed && this._bodyKind === 'text') {
      this.bodyUsed = true
      return Promise.resolve(this._bodyText)
    }
    return this._consumeBytes().then((bytes) => utf8Decode(bytes, bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0))
  }
  json() {
    return this.text().then((text) => JSON.parse(text))
  }
  arrayBuffer() {
    return this._consumeBytes().then((bytes) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
  }
  bytes() {
    return this._consumeBytes().then((bytes) => bytes.slice())
  }
  blob() {
    return this._consumeBytes().then((bytes) => new Blob([bytes], { type: (this.headers && this.headers.get('content-type')) || '' }))
  }
  formData() {
    return Promise.reject(new TypeError('formData() is not supported by the Android plugin runtime'))
  }
}

export class Request extends Body {
  constructor(input, init = {}) {
    super()
    const source = input instanceof Request ? input : null
    this.url = source ? source.url : new URL(input instanceof URL ? input.href : String(input)).href
    this.method = String(init.method || (source ? source.method : 'GET')).toUpperCase()
    this.headers = new Headers(init.headers !== undefined ? init.headers : source ? source.headers : undefined)
    this.signal = init.signal !== undefined ? init.signal : source ? source.signal : null
    this.redirect = init.redirect || (source ? source.redirect : 'follow')
    this.credentials = init.credentials || 'same-origin'
    this.mode = init.mode || 'cors'
    this.cache = init.cache || 'default'
    this.referrer = init.referrer || 'about:client'
    this.keepalive = Boolean(init.keepalive)
    const body = init.body !== undefined ? init.body : null
    if (body !== null && (this.method === 'GET' || this.method === 'HEAD')) {
      throw new TypeError('Request with GET/HEAD method cannot have body.')
    }
    if (body === null && source) {
      this._bodyKind = source._bodyKind
      this._bodyText = source._bodyText
      this._bodyBytes = source._bodyBytes
      this._bodyStream = source._bodyStream
      this.bodyUsed = false
    } else {
      const extracted = this._initBody(body)
      if (extracted.contentType && !this.headers.has('content-type')) this.headers.set('content-type', extracted.contentType)
    }
  }
  clone() {
    return new Request(this)
  }
}

export class Response extends Body {
  constructor(body = null, init = {}) {
    super()
    this.status = init.status === undefined ? 200 : Number(init.status)
    if (!Number.isInteger(this.status) || this.status < 200 || this.status > 599) {
      if (!init._internal) throw new RangeError(`init["status"] must be in the range of 200 to 599, inclusive.`)
    }
    this.statusText = init.statusText === undefined ? '' : String(init.statusText)
    this.headers = new Headers(init.headers)
    this.url = init.url || ''
    this.redirected = Boolean(init.redirected)
    this.type = init.type || 'default'
    const extracted = this._initBody(body)
    if (extracted.contentType && !this.headers.has('content-type')) this.headers.set('content-type', extracted.contentType)
  }
  get ok() {
    return this.status >= 200 && this.status <= 299
  }
  clone() {
    if (this.bodyUsed) throw new TypeError('Response.clone: Body has already been consumed.')
    const copy = new Response(null, { status: this.status, statusText: this.statusText, headers: this.headers, url: this.url, redirected: this.redirected, type: this.type, _internal: true })
    copy._bodyKind = this._bodyKind
    copy._bodyText = this._bodyText
    copy._bodyBytes = this._bodyBytes
    copy._bodyStream = null
    if (this._bodyKind === 'stream') throw new TypeError('Response.clone is not supported for streaming bodies')
    return copy
  }
  static json(data, init = {}) {
    const headers = new Headers(init.headers)
    if (!headers.has('content-type')) headers.set('content-type', 'application/json')
    return new Response(JSON.stringify(data), { ...init, headers })
  }
  static error() {
    const response = new Response(null, { status: 0, _internal: true })
    response.type = 'error'
    return response
  }
  static redirect(url, status = 302) {
    return new Response(null, { status, headers: { location: new URL(url).href } })
  }
}

// ── Transport ──────────────────────────────────────────────────────────────
/** Loopback servers created through the node:http shim, keyed by port. */
export const virtualServers = new Map()
/** Set while the provider adapter resolves a proxy URL into its upstream media request. */
export const mediaCapture = { active: null }
/**
 * Hosts the plugin declared (androidRuntime networkHosts and mediaHosts). The
 * Android host only allows HTTPS outside the user's own server, so plain HTTP
 * to these hosts is upgraded instead of failing, except for the exact hosts
 * the plugin declared in androidRuntime.cleartextHosts.
 */
export const transportPolicy = { secureHosts: [], cleartextHosts: [] }

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1', '0.0.0.0'])

/** Exact host names, or `*.example.com` for any subdomain of example.com. */
export function hostMatches(patterns, hostname) {
  const host = String(hostname).toLowerCase()
  for (const pattern of patterns) {
    if (pattern.startsWith('*.')) {
      if (host.endsWith(pattern.slice(1)) && host.length > pattern.length - 1) return true
    } else if (pattern === host) return true
  }
  return false
}

/** Upgrades http:// URLs to declared hosts in place; returns whether it did. */
export function upgradeToHttps(url) {
  if (url.protocol !== 'http:') return false
  const host = url.hostname.toLowerCase()
  if (transportPolicy.cleartextHosts.includes(host) || !hostMatches(transportPolicy.secureHosts, host)) return false
  url.protocol = 'https:'
  return true
}

function networkError(message, cause) {
  const error = new TypeError('fetch failed')
  error.cause = cause instanceof Error ? cause : new Error(message)
  if (cause && cause.code) error.cause.code = cause.code
  return error
}

function bodyPayload(request) {
  if (request._bodyKind === 'none') return Promise.resolve(null)
  if (request._bodyKind === 'text') return Promise.resolve({ text: request._bodyText })
  if (request._bodyKind === 'bytes') return Promise.resolve({ bytes: request._bodyBytes })
  return readAll(request._bodyStream).then((bytes) => ({ bytes }))
}

function readHostBody(reply) {
  if (reply.bodyId === undefined || reply.bodyId === null) return reply.body || ''
  const parts = []
  let offset = 0
  for (;;) {
    const chunk = hostCall('http.body', { id: reply.bodyId, offset })
    parts.push(chunk.data)
    offset += chunk.data.length
    if (chunk.done) break
  }
  return parts.join('')
}

function hostFetch(request, payload) {
  const args = {
    url: request.url,
    method: request.method,
    headers: request.headers._pairs(),
    redirect: request.redirect === 'manual' || request.redirect === 'error' ? 'manual' : 'follow'
  }
  if (payload && payload.text !== undefined) args.text = payload.text
  else if (payload && payload.bytes) args.body = bytesToBase64(payload.bytes)
  let reply
  try {
    reply = hostCall('http.request', args)
  } catch (error) {
    throw networkError(error.message, error)
  }
  if (request.redirect === 'error' && reply.status >= 300 && reply.status < 400) {
    throw networkError('unexpected redirect')
  }
  const response = new Response(null, {
    status: reply.status,
    statusText: reply.statusText || '',
    headers: reply.headers || [],
    url: reply.url || request.url,
    redirected: Boolean(reply.redirected),
    type: 'basic',
    _internal: true
  })
  const raw = readHostBody(reply)
  if (request.method === 'HEAD' || reply.status === 204 || reply.status === 304) response._bodyKind = 'none'
  else if (reply.encoding === 'base64') response._setBytes(base64ToBytes(raw))
  else response._setText(raw)
  return response
}

function captureMatches(url, request) {
  const capture = mediaCapture.active
  if (!capture || capture.done) return false
  return capture.matches(url, request)
}

function captureResponse(request) {
  const capture = mediaCapture.active
  capture.done = true
  capture.onCapture({ url: request.url, method: request.method, headers: request.headers._pairs() })
  const response = new Response(new Uint8Array([0]), {
    status: 206,
    statusText: 'Partial Content',
    headers: {
      'content-type': 'application/octet-stream',
      'content-length': '1',
      'content-range': 'bytes 0-0/1',
      'accept-ranges': 'bytes'
    },
    url: request.url,
    type: 'basic'
  })
  return response
}

function dispatch(request) {
  const url = new URL(request.url)
  if (url.protocol === 'data:') {
    const match = /^([^,]*?)(;base64)?,([\s\S]*)$/.exec(request.url.slice(5))
    if (!match) throw networkError('invalid data URL')
    const bytes = match[2] ? base64ToBytes(match[3]) : utf8Encode(decodeURIComponent(match[3]))
    return new Response(bytes, { headers: { 'content-type': match[1] || 'text/plain;charset=US-ASCII' } })
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw networkError(`unsupported protocol ${url.protocol}`)
  if (upgradeToHttps(url)) request.url = url.href
  if (captureMatches(url, request)) return captureResponse(request)
  if (LOOPBACK_HOSTS.has(url.hostname)) {
    const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80))
    const server = virtualServers.get(port)
    if (!server) {
      const cause = new Error(`connect ECONNREFUSED 127.0.0.1:${port}`)
      cause.code = 'ECONNREFUSED'
      throw networkError(cause.message, cause)
    }
    return bodyPayload(request).then((payload) => server._dispatch(request, payload))
  }
  return bodyPayload(request).then((payload) => hostFetch(request, payload))
}

function abortReason(signal) {
  return signal && signal.reason !== undefined ? signal.reason : new DOMException('This operation was aborted', 'AbortError')
}

export function fetch(input, init) {
  return new Promise((resolve, reject) => {
    let request
    try {
      request = new Request(input, init || {})
    } catch (error) {
      reject(error)
      return
    }
    const signal = request.signal
    if (signal && signal.aborted) {
      reject(abortReason(signal))
      return
    }
    let settled = false
    const onAbort = () => {
      if (settled) return
      settled = true
      reject(abortReason(signal))
    }
    if (signal && typeof signal.addEventListener === 'function') signal.addEventListener('abort', onAbort, { once: true })
    const finish = (callback) => (value) => {
      if (settled) return
      settled = true
      if (signal && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', onAbort)
      callback(value)
    }
    // IO runs as a macrotask so callers observe the usual asynchronous ordering.
    queueMacrotask(() => {
      if (settled) return
      Promise.resolve()
        .then(() => dispatch(request))
        .then(finish(resolve), finish(reject))
    })
  })
}
