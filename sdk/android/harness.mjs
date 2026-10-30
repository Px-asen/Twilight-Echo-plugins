// Node reference host for Android ABI v2 plugin bundles. Runs a built bundle in
// a bare vm context (QuickJS-like: no web or Node globals, ES2021+ built-ins
// removed) and implements the host API the Android worker exposes, including
// grant checks. Network IO runs in a worker thread so host calls stay
// synchronous, exactly like the Binder calls on Android.
import crypto from 'node:crypto'
import vm from 'node:vm'
import zlib from 'node:zlib'
import { MessageChannel, Worker, receiveMessageOnPort } from 'node:worker_threads'
import { buildAndroidPlugin } from './build.mjs'

export const BODY_CHUNK_CHARS = 128 * 1024
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024
const FORBIDDEN_REQUEST_HEADERS = new Set([
  'host', 'connection', 'content-length', 'transfer-encoding', 'upgrade', 'keep-alive', 'te', 'trailer', 'accept-encoding', 'expect'
])
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
const LEVELS = { debug: 0, info: 1, warn: 2, error: 3, silent: 4 }

// ── Network worker ─────────────────────────────────────────────────────────
const WORKER_SOURCE = `
const { workerData } = require('node:worker_threads')
const { port, signal } = workerData
const flag = new Int32Array(signal)
const sockets = new Map()
const queues = new Map()
let nextSocket = 1
let pendingPoll = null
function reply(id, message) {
  port.postMessage(Object.assign({ id }, message))
  Atomics.store(flag, 0, 1)
  Atomics.notify(flag, 0)
}
function queued(ids) {
  const events = []
  for (const id of ids) {
    const queue = queues.get(id)
    if (queue && queue.length) events.push(...queue.splice(0))
  }
  return events
}
function push(id, event) {
  if (!queues.has(id)) queues.set(id, [])
  queues.get(id).push(Object.assign({ id }, event))
  if (pendingPoll && pendingPoll.ids.includes(id)) {
    const poll = pendingPoll
    pendingPoll = null
    clearTimeout(poll.timer)
    reply(poll.job, { ok: true, value: queued(poll.ids) })
  }
}
port.on('message', async (job) => {
  try {
    if (job.kind === 'http') {
      const init = { method: job.method, headers: job.headers, redirect: 'manual', signal: AbortSignal.timeout(job.timeoutMs) }
      if (job.body) init.body = Buffer.from(job.body, 'base64')
      const response = await fetch(job.url, init)
      const bytes = Buffer.from(await response.arrayBuffer())
      const headers = []
      response.headers.forEach((value, name) => { if (name !== 'set-cookie') headers.push([name, value]) })
      for (const cookie of response.headers.getSetCookie()) headers.push(['set-cookie', cookie])
      reply(job.id, { ok: true, value: { status: response.status, statusText: response.statusText, headers, body: bytes.toString('base64') } })
    } else if (job.kind === 'ws.open') {
      const id = nextSocket++
      const socket = new WebSocket(job.url, { protocols: job.protocols, headers: Object.fromEntries(job.headers) })
      socket.binaryType = 'arraybuffer'
      sockets.set(id, socket)
      socket.onopen = () => push(id, { type: 'open', protocol: socket.protocol })
      socket.onmessage = (event) => typeof event.data === 'string'
        ? push(id, { type: 'message', text: event.data })
        : push(id, { type: 'message', binary: Buffer.from(event.data).toString('base64') })
      socket.onerror = (event) => push(id, { type: 'error', message: String(event.message || 'WebSocket error') })
      socket.onclose = (event) => { sockets.delete(id); push(id, { type: 'close', code: event.code, reason: event.reason }) }
      reply(job.id, { ok: true, value: { id } })
    } else if (job.kind === 'ws.send') {
      const socket = sockets.get(job.socket)
      if (!socket) throw new Error('WebSocket 已关闭')
      socket.send(job.text !== undefined ? job.text : Buffer.from(job.binary, 'base64'))
      reply(job.id, { ok: true, value: null })
    } else if (job.kind === 'ws.close') {
      const socket = sockets.get(job.socket)
      if (socket) socket.close(job.code, job.reason)
      reply(job.id, { ok: true, value: null })
    } else if (job.kind === 'ws.poll') {
      const events = queued(job.ids)
      if (events.length || job.timeoutMs <= 0) reply(job.id, { ok: true, value: events })
      else pendingPoll = { job: job.id, ids: job.ids, timer: setTimeout(() => { pendingPoll = null; reply(job.id, { ok: true, value: queued(job.ids) }) }, job.timeoutMs) }
    }
  } catch (error) {
    reply(job.id, { ok: false, error: (error.cause && error.cause.message) || error.message })
  }
})
`

class NetworkWorker {
  constructor() {
    const channel = new MessageChannel()
    this.signal = new SharedArrayBuffer(4)
    this.flag = new Int32Array(this.signal)
    this.port = channel.port1
    this.worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { port: channel.port2, signal: this.signal },
      transferList: [channel.port2]
    })
    this.worker.unref()
    this.nextJob = 1
  }
  request(job, timeoutMs) {
    const id = this.nextJob++
    this.port.postMessage({ ...job, id })
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const received = receiveMessageOnPort(this.port)
      if (received) {
        if (received.message.id !== id) continue
        if (!received.message.ok) throw new Error(received.message.error)
        return received.message.value
      }
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw new Error('宿主网络请求超时')
      Atomics.wait(this.flag, 0, 0, Math.min(remaining, 50))
      Atomics.store(this.flag, 0, 0)
    }
  }
  close() {
    this.port.close()
    return this.worker.terminate()
  }
}

// ── Host API ───────────────────────────────────────────────────────────────
function b64(value) {
  return Buffer.from(String(value || ''), 'base64')
}

function hostMatches(patterns, host) {
  return patterns.some((pattern) =>
    pattern.startsWith('*.') ? host.endsWith(pattern.slice(1)) && host.length > pattern.length - 1 : pattern === host
  )
}

function isUtf8Text(bytes) {
  if (bytes.includes(0)) return false
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return true
  } catch {
    return false
  }
}

function sleepSync(ms) {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * Host emulator. `routes(request)` may answer HTTP requests offline: return
 * { status, headers, body } (body: string | Buffer) or undefined to use the
 * network (only when `network: true`).
 */
export function createHostEmulator({
  manifest,
  settings = {},
  userServer = null,
  routes = null,
  network = false,
  webSockets = null,
  logLevel = 'warn',
  timeoutMs = 20000
} = {}) {
  const runtime = (manifest && manifest.androidRuntime) || {}
  const permissions = runtime.permissions || []
  const networkHosts = (runtime.networkHosts || []).map((host) => host.toLowerCase())
  const mediaHosts = (runtime.mediaHosts || []).map((host) => host.toLowerCase())
  // Exact hosts reachable over plain HTTP; they must be granted above as well.
  const cleartextHosts = (runtime.cleartextHosts || []).map((host) => host.toLowerCase())
  const store = { ...settings }
  const logs = []
  const requests = []
  const qrTexts = []
  const bodies = new Map()
  const fakeSockets = new Map()
  let nextBody = 1
  let nextFakeSocket = 1000
  let worker = null
  let serverOrigin = null

  const host = {
    settings: store,
    logs,
    requests,
    qrTexts,
    /** Mirrors the Android login form: the user, not the plugin, grants a server origin. */
    grantUserServer(url) {
      if (!runtime.userServer) throw new Error('插件没有声明 userServer')
      const parsed = new URL(url)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('服务器地址必须使用 HTTP 或 HTTPS')
      serverOrigin = parsed.origin
    },
    get userServerOrigin() {
      return serverOrigin
    },
    call(method, args) {
      switch (method) {
        case 'settings.get':
        case 'settings.set':
        case 'settings.delete': {
          if (!permissions.includes('settings')) throw new Error('插件未声明 settings 权限')
          const key = String(args.key || '')
          if (method === 'settings.get') return key ? (key in store ? store[key] : null) : { ...store }
          if (!key || key.length > 128) throw new Error('设置键无效')
          if (method === 'settings.set') store[key] = args.value === undefined ? null : JSON.parse(JSON.stringify(args.value))
          else delete store[key]
          if (JSON.stringify(store).length > 256000) throw new Error('插件设置过大')
          return null
        }
        case 'log': {
          const level = LEVELS[args.level] === undefined ? 'info' : args.level
          logs.push({ level, message: String(args.message) })
          if (LEVELS[level] >= LEVELS[logLevel]) console.log(`[plugin:${level}] ${args.message}`)
          return null
        }
        case 'sleep':
          sleepSync(Math.max(0, Math.min(2000, Number(args.ms) || 0)))
          return null
        case 'qrImage':
          if (typeof args.text !== 'string' || !args.text || args.text.length > 2048) throw new Error('二维码内容无效')
          qrTexts.push(args.text)
          return `data:image/png;base64,${PNG_1X1}`
        case 'crypto.random': {
          const size = Number(args.size)
          if (!Number.isInteger(size) || size < 0 || size > 65536) throw new Error('随机数长度无效')
          return crypto.randomBytes(size).toString('base64')
        }
        case 'crypto.hash':
          return crypto.createHash(args.algorithm).update(b64(args.data)).digest('base64')
        case 'crypto.hmac':
          return crypto.createHmac(args.algorithm, b64(args.key)).update(b64(args.data)).digest('base64')
        case 'crypto.cipher': {
          const algorithm = String(args.algorithm)
          if (!/^aes-(128|192|256)-(ecb|cbc|ctr|gcm)$/.test(algorithm)) throw new Error(`不支持的加密算法 ${algorithm}`)
          const gcm = algorithm.endsWith('-gcm')
          const options = gcm ? { authTagLength: Number(args.authTagLength) || 16 } : undefined
          const iv = algorithm.endsWith('-ecb') ? null : b64(args.iv)
          const cipher = args.decrypt
            ? crypto.createDecipheriv(algorithm, b64(args.key), iv, options)
            : crypto.createCipheriv(algorithm, b64(args.key), iv, options)
          if (!gcm) cipher.setAutoPadding(args.padding !== false)
          if (args.aad) cipher.setAAD(b64(args.aad))
          if (gcm && args.decrypt) cipher.setAuthTag(b64(args.authTag))
          const data = Buffer.concat([cipher.update(b64(args.data)), cipher.final()])
          const result = { data: data.toString('base64') }
          if (gcm && !args.decrypt) result.authTag = cipher.getAuthTag().toString('base64')
          return result
        }
        case 'crypto.publicEncrypt':
          return crypto
            .publicEncrypt({ key: String(args.key), padding: Number(args.padding), oaepHash: args.oaepHash || 'sha1' }, b64(args.data))
            .toString('base64')
        case 'crypto.pbkdf2':
          if (Number(args.iterations) > 1_000_000 || Number(args.keyLength) > 1024) throw new Error('PBKDF2 参数过大')
          return crypto.pbkdf2Sync(b64(args.password), b64(args.salt), Number(args.iterations), Number(args.keyLength), args.digest).toString('base64')
        case 'zlib.process':
          return zlibProcess(args)
        case 'http.request':
          return httpRequest(args)
        case 'http.body': {
          const entry = bodies.get(Number(args.id))
          if (!entry) throw new Error('响应内容已失效')
          const offset = Number(args.offset) || 0
          const data = entry.slice(offset, offset + BODY_CHUNK_CHARS)
          const done = offset + data.length >= entry.length
          if (done) bodies.delete(Number(args.id))
          return { data, done }
        }
        case 'ws.open':
        case 'ws.send':
        case 'ws.close':
        case 'ws.poll':
          return webSocketCall(method, args)
        default:
          throw new Error(`插件未获准调用宿主能力：${method}`)
      }
    },
    close() {
      for (const socket of fakeSockets.values()) socket.close?.()
      return worker ? worker.close() : Promise.resolve()
    }
  }

  function zlibProcess(args) {
    const data = b64(args.data)
    const level = Number.isInteger(args.level) && args.level >= -1 && args.level <= 9 ? args.level : -1
    // The Android host refuses output past 8 MiB (MAX_ZLIB_OUTPUT); the harness matches it.
    const options = { level, maxOutputLength: 8 * 1024 * 1024 }
    const fns = {
      gzip: zlib.gzipSync, gunzip: zlib.gunzipSync, deflate: zlib.deflateSync, inflate: zlib.inflateSync,
      deflateRaw: zlib.deflateRawSync, inflateRaw: zlib.inflateRawSync, unzip: zlib.unzipSync
    }
    // Android has no Brotli codec; keep parity so tests catch it.
    if (!fns[args.mode]) throw new Error(`不支持的压缩方式 ${args.mode}`)
    return fns[args.mode](data, options).toString('base64')
  }

  function checkGrant(url) {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`不支持的协议 ${url.protocol}`)
    if (serverOrigin && url.origin === serverOrigin) return
    const hostname = url.hostname.toLowerCase()
    if (url.protocol !== 'https:' && !cleartextHosts.includes(hostname)) throw new Error(`插件只能通过 HTTPS 访问 ${hostname}`)
    if (url.username || url.password) throw new Error('插件请求不能包含账号信息')
    if (networkHosts.includes(hostname) || hostMatches(mediaHosts, hostname)) return
    throw new Error(`插件未获准访问 ${hostname}`)
  }

  function exchange(request) {
    requests.push({ url: request.url, method: request.method, headers: request.headers })
    const routed = routes ? routes({ ...request, body: request.body ? b64(request.body) : null }) : undefined
    if (routed) {
      const body = routed.body === undefined ? Buffer.alloc(0) : Buffer.isBuffer(routed.body) ? routed.body : Buffer.from(String(routed.body))
      const headers = Array.isArray(routed.headers) ? routed.headers : Object.entries(routed.headers || {})
      return { status: routed.status || 200, statusText: routed.statusText || '', headers: headers.map(([k, v]) => [k.toLowerCase(), String(v)]), body }
    }
    if (!network) throw new Error(`离线测试没有为 ${request.method} ${request.url} 提供响应`)
    if (!worker) worker = new NetworkWorker()
    const reply = worker.request({ kind: 'http', ...request, timeoutMs }, timeoutMs + 2000)
    // fetch() decoded any content-encoding; the plugin sees the decoded body.
    return { ...reply, headers: reply.headers.filter(([name]) => name !== 'content-encoding' && name !== 'content-length'), body: b64(reply.body) }
  }

  function httpRequest(args) {
    if (!permissions.includes('network')) throw new Error('插件未声明 network 权限')
    let url = new URL(String(args.url))
    let method = String(args.method || 'GET').toUpperCase()
    let headers = (Array.isArray(args.headers) ? args.headers : [])
      .map(([name, value]) => [String(name).toLowerCase(), String(value)])
      .filter(([name]) => !FORBIDDEN_REQUEST_HEADERS.has(name) && !name.startsWith('proxy-'))
    let body = args.text !== undefined ? Buffer.from(String(args.text), 'utf8').toString('base64') : args.body || null
    let redirected = false
    for (let hop = 0; ; hop++) {
      checkGrant(url)
      const reply = exchange({ url: url.href, method, headers, body })
      const location = reply.headers.find(([name]) => name === 'location')?.[1]
      if (args.redirect !== 'manual' && REDIRECT_STATUSES.has(reply.status) && location) {
        if (hop >= 5) throw new Error('重定向次数过多')
        const next = new URL(location, url)
        if (reply.status === 303 || ((reply.status === 301 || reply.status === 302) && method === 'POST')) {
          if (method !== 'HEAD') method = 'GET'
          body = null
          headers = headers.filter(([name]) => !name.startsWith('content-'))
        }
        if (next.origin !== url.origin) headers = headers.filter(([name]) => name !== 'authorization')
        url = next
        redirected = true
        continue
      }
      if (reply.body.length > MAX_RESPONSE_BYTES) throw new Error('响应内容过大')
      const type = reply.headers.find(([name]) => name === 'content-type')?.[1]?.toLowerCase() || ''
      const textual = !type || /^text\/|json|xml|javascript|ecmascript|x-www-form-urlencoded|graphql/.test(type)
      const encoding = textual && isUtf8Text(reply.body) ? 'utf8' : 'base64'
      const text = encoding === 'utf8' ? reply.body.toString('utf8') : reply.body.toString('base64')
      const result = { status: reply.status, statusText: reply.statusText, url: url.href, redirected, headers: reply.headers, encoding }
      if (text.length > BODY_CHUNK_CHARS) {
        const id = nextBody++
        bodies.set(id, text)
        result.bodyId = id
      } else result.body = text
      return result
    }
  }

  function webSocketCall(method, args) {
    if (!permissions.includes('network')) throw new Error('插件未声明 network 权限')
    if (method === 'ws.open') {
      const url = new URL(String(args.url))
      if (url.protocol !== 'wss:' && !(serverOrigin && url.protocol === 'ws:')) throw new Error('WebSocket 只能使用 WSS')
      checkGrant(new URL(url.href.replace(/^ws/, 'http')))
      const fake = webSockets ? webSockets(url.href, args) : undefined
      if (fake) {
        const id = nextFakeSocket++
        const queue = []
        const socket = { id, queue, ...fake }
        fakeSockets.set(id, socket)
        socket.emit = (event) => queue.push({ id, ...event })
        socket.open?.(socket)
        return { id }
      }
      if (!network) throw new Error(`离线测试没有为 ${url.href} 提供 WebSocket`)
      if (!worker) worker = new NetworkWorker()
      return worker.request({ kind: 'ws.open', url: url.href, protocols: args.protocols || [], headers: args.headers || [] }, timeoutMs)
    }
    if (method === 'ws.poll') {
      const ids = Array.isArray(args.ids) ? args.ids.map(Number) : []
      const timeout = Math.max(0, Math.min(2000, Number(args.timeoutMs) || 0))
      const fakeIds = ids.filter((id) => fakeSockets.has(id))
      if (fakeIds.length) {
        const events = fakeIds.flatMap((id) => fakeSockets.get(id).queue.splice(0))
        if (!events.length) sleepSync(Math.min(timeout, 20))
        return events
      }
      if (!worker) return []
      return worker.request({ kind: 'ws.poll', ids, timeoutMs: timeout }, timeout + 2000)
    }
    const fake = fakeSockets.get(Number(args.id))
    if (fake) {
      if (method === 'ws.send') fake.send?.(args.text !== undefined ? args.text : b64(args.binary), fake)
      else {
        fakeSockets.delete(Number(args.id))
        fake.queue.push({ id: fake.id, type: 'close', code: Number(args.code) || 1000, reason: String(args.reason || '') })
      }
      return null
    }
    if (!worker) throw new Error('WebSocket 已关闭')
    return worker.request({ kind: method, socket: Number(args.id), text: args.text, binary: args.binary, code: args.code, reason: args.reason }, timeoutMs)
  }

  return host
}

// ── QuickJS-like context ───────────────────────────────────────────────────
const QUICKJS_2020_MISSING = `
  (function () {
    var typed = Object.getPrototypeOf(Uint8Array.prototype)
    ;[Array.prototype, String.prototype, typed].forEach(function (p) { delete p.at })
    ;[Array.prototype, typed].forEach(function (p) {
      delete p.findLast; delete p.findLastIndex; delete p.toSorted; delete p.toReversed; delete p.toSpliced; delete p.with
    })
    delete Object.hasOwn; delete Object.groupBy; delete Map.groupBy; delete Array.fromAsync
    delete String.prototype.isWellFormed; delete String.prototype.toWellFormed
    delete Promise.withResolvers; delete Error.captureStackTrace
    delete globalThis.WeakRef; delete globalThis.FinalizationRegistry; delete globalThis.Intl; delete globalThis.Iterator
    delete globalThis.SharedArrayBuffer; delete globalThis.Atomics; delete globalThis.WebAssembly
  })()
`

/** Evaluates a bundle and returns its ABI object plus convenience calls. */
export function loadAndroidPlugin({ script, manifest, host, emulateQuickJs = true, filename }) {
  const context = vm.createContext({})
  if (emulateQuickJs) vm.runInContext(QUICKJS_2020_MISSING, context)
  context.__PLUGIN_HOST__ = {
    call(method, argsJson) {
      try {
        return JSON.stringify({ ok: true, value: host.call(method, JSON.parse(argsJson)) ?? null })
      } catch (error) {
        return JSON.stringify({ ok: false, error: error.message || String(error) })
      }
    }
  }
  vm.runInContext(script, context, { filename: filename || `${manifest.id}/${manifest.androidRuntime.entry}` })
  const abi = context.__TWILIGHT_PLUGIN__
  if (!abi || abi.apiVersion !== 2 || typeof abi.invoke !== 'function') throw new Error('脚本没有导出 Android ABI v2')
  const invoke = (request) => JSON.parse(abi.invoke(JSON.stringify(request)))
  const unwrap = (envelope) => {
    if (!envelope.ok) throw Object.assign(new Error(envelope.error), { envelope })
    return envelope.value
  }
  return {
    context,
    invoke,
    activate: () => unwrap(invoke({ operation: 'activate', manifest })),
    call: (method, ...args) => unwrap(invoke({ operation: 'call', method, args })),
    command: (command, ...args) => unwrap(invoke({ operation: 'command', command, args })),
    resolveMedia: (url, kind = 'stream') => unwrap(invoke({ operation: 'resolveMedia', url, kind })),
    deactivate: () => unwrap(invoke({ operation: 'deactivate' }))
  }
}

/** Builds <pluginRoot>/android.mjs and loads it against a host emulator. */
export async function createHarness(pluginRoot, options = {}) {
  const { code, manifest } = await buildAndroidPlugin(pluginRoot, { minify: options.minify ?? false })
  const host = createHostEmulator({ manifest, ...options })
  const plugin = loadAndroidPlugin({ script: code, manifest, host, emulateQuickJs: options.emulateQuickJs !== false })
  return { ...plugin, host, manifest, script: code, close: () => host.close() }
}
