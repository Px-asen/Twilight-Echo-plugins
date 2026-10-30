import { hostLog, resetLogBudget } from './runtime/index.js'
import { hostCall } from './runtime/host.js'
import { TwilightPromise as Promise, pump, run } from './runtime/loop.js'
import { AbortController } from './runtime/events.js'
import { Request, hostMatches, mediaCapture, transportPolicy, upgradeToHttps, virtualServers } from './runtime/fetch.js'
import { URL } from './runtime/url.js'

// Adapts a desktop provider plugin (index.mjs exporting activate/deactivate)
// to the Android worker ABI v2:
//
//   globalThis.__TWILIGHT_PLUGIN__ = { apiVersion: 2, invoke(requestJson) → envelopeJson }
//
// invoke() is synchronous for the worker: it runs the plugin's event loop
// (see runtime/loop.js) until the request settles or its deadline passes.

/**
 * Argument counts the desktop renderer always passes (renderer/providers/index.ts).
 * Android pads to the same count so the invocation context stays the last
 * argument — `handler(...args, { signal, idempotencyKey })`.
 */
export const PROVIDER_ARITY = {
  checkLogin: 0, getProfile: 0, logout: 0, getQrLogin: 0, getQrKey: 0,
  fetchRecommendSongs: 0, fetchRecommendPlaylists: 0, fetchPlaylistCategories: 0,
  fetchPersonalFm: 0, fetchPrivateContent: 0, fetchSavedAlbums: 0, fetchSavedArtists: 0, fetchToplists: 0,
  getLyrics: 1, getQrImage: 1, checkQrLogin: 1, fetchUserLibrary: 1, fetchLikedTracks: 1,
  fetchArtistTopSongs: 1, fetchArtistAlbums: 1, fetchArtistIntro: 1, fetchArtistFollowState: 1,
  fetchAlbumTracks: 1, fetchArtistPlaylists: 1, fetchPlayRecords: 1, fetchRecentSongs: 1,
  isTrackLiked: 1, deletePlaylist: 1, sendCaptcha: 1,
  getPlaybackUrl: 2, fetchPlaylistTracks: 2, fetchUserPlaylistsByUid: 2, followArtist: 2, followUser: 2,
  likeTrack: 2, createPlaylist: 2, addTracksToPlaylist: 2, removeTracksFromPlaylist: 2,
  loginByPhonePassword: 2, loginByPhoneCaptcha: 2, loginByEmailPassword: 2,
  searchSongs: 3, searchAlbums: 3, searchPlaylists: 3, searchArtists: 3, readPlaylistImportPage: 3,
  fetchHighQualityPlaylists: 3, fetchUserFollows: 3, fetchUserFolloweds: 3, loginWithServer: 3,
  fetchLikedTracksPage: 3,
  fetchPlaylistTracksPage: 4, fetchDiscoveryPlaylists: 4
}

/** Desktop-only flows (browser windows, file downloads, cloud uploads). */
const EXCLUDED_METHODS = new Set([
  'openOfficialLogin', 'createDownload', 'getDownloadStatus', 'getDownloadFile', 'cancelDownload',
  'prepareCloudUpload', 'completeCloudUpload', 'fetchCloudSongsPage', 'getCloudDownloadUrl'
])

const DEFAULT_DEADLINE_MS = 40000
const MAX_DEADLINE_MS = 50000
const MAX_REWRITTEN_URLS = 200
const MAX_CALL_ARGS = 8
/** Request headers a captured media request may not hand to the player. */
const DROPPED_MEDIA_HEADERS = new Set(['range', 'host', 'connection', 'accept-encoding', 'content-length', 'transfer-encoding'])

function errorMessage(error) {
  if (error && typeof error === 'object' && typeof error.message === 'string' && error.message) {
    // fetch() reports transport failures as "fetch failed" with the reason in `cause`.
    const cause = error.cause
    if (error.message === 'fetch failed' && cause && typeof cause.message === 'string' && cause.message) return cause.message
    return error.message
  }
  return String(error === undefined ? '插件运行失败' : error)
}

function unavailable(name) {
  return () => Promise.reject(new Error(`${name} 在 Android 上不可用`))
}

function isLoopbackHost(hostname) {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]' || hostname === '::1'
}

function virtualServerFor(value) {
  if (typeof value !== 'string' || !/^https?:\/\//i.test(value)) return null
  let url
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (!isLoopbackHost(url.hostname)) return null
  const server = virtualServers.get(Number(url.port || (url.protocol === 'https:' ? 443 : 80)))
  return server ? { url, server } : null
}

/**
 * Wraps a desktop provider module for the Android worker.
 *
 * options:
 *   setup(context)            runs before plugin.activate(context)
 *   methods: { name: fn|null } replaces (or with null removes) provider methods
 *   exclude: [name]           removes provider methods
 *   ui: {...}                 patches the registered provider ui
 *   commands: { name: fn } | ({ runCommand, registered }) => ({ name: fn })
 *                             adds or replaces UI commands; a null value removes one.
 *                             registered(name) is the plugin's own handler, so an
 *                             Android command can wrap the one it replaces
 *   panels(panels) → panels   edits the settings panels shown on Android
 */
export function defineAndroidProvider(plugin, options = {}) {
  if (!plugin || typeof plugin.activate !== 'function') throw new TypeError('defineAndroidProvider 需要导出 activate() 的插件模块')

  const state = {
    manifest: null,
    networkHosts: [],
    mediaHosts: [],
    provider: null,
    handlers: {},
    panels: [],
    commands: new Map(),
    notices: [],
    active: false
  }

  // ── Desktop plugin context ──────────────────────────────────────────────
  const settings = {
    get(key) {
      return new Promise((resolve) => {
        if (key === undefined || key === null) resolve(hostCall('settings.get', {}) || {})
        else {
          const value = hostCall('settings.get', { key: String(key) })
          resolve(value === null ? undefined : value)
        }
      })
    },
    set(key, value) {
      return new Promise((resolve) => {
        hostCall('settings.set', { key: String(key), value: value === undefined ? null : value })
        resolve()
      })
    },
    delete(key) {
      return new Promise((resolve) => {
        hostCall('settings.delete', { key: String(key) })
        resolve()
      })
    }
  }

  const logger = {
    debug: (message) => hostLog('debug', [message]),
    info: (message) => hostLog('info', [message]),
    warn: (message) => hostLog('warn', [message]),
    error: (message) => hostLog('error', [message])
  }

  const twilight = {
    events: { on: () => () => {} },
    player: {
      getPlaybackInfo: unavailable('twilight.player'),
      play: unavailable('twilight.player'),
      pause: unavailable('twilight.player'),
      togglePause: unavailable('twilight.player'),
      stop: unavailable('twilight.player'),
      next: unavailable('twilight.player'),
      previous: unavailable('twilight.player'),
      playTracks: unavailable('twilight.player'),
      setVolume: unavailable('twilight.player'),
      seek: unavailable('twilight.player'),
      setPlayMode: unavailable('twilight.player')
    },
    providers: {
      register(provider) {
        return new Promise((resolve) => {
          if (!provider || typeof provider.id !== 'string' || !provider.id.trim()) throw new Error('音源 ID 不能为空')
          if (state.provider && state.provider.id !== provider.id) throw new Error('Android 插件只能注册一个音源')
          const handlers = {}
          for (const method of Object.keys(PROVIDER_ARITY)) {
            if (typeof provider[method] === 'function' && !EXCLUDED_METHODS.has(method)) handlers[method] = provider[method]
          }
          state.provider = {
            id: provider.id.trim().toLowerCase(),
            name: String(provider.name || provider.id),
            capabilities: Array.isArray(provider.capabilities) ? provider.capabilities.map(String) : [],
            ui: provider.ui && typeof provider.ui === 'object' ? provider.ui : {}
          }
          state.handlers = handlers
          resolve()
        })
      }
    },
    ui: {
      register(contribution) {
        return new Promise((resolve) => {
          if (contribution && contribution.kind === 'settingsPanel' && typeof contribution.command === 'string') {
            state.panels = state.panels.filter((panel) => panel.id !== contribution.id)
            state.panels.push({
              id: String(contribution.id || contribution.command),
              title: String(contribution.title || ''),
              description: contribution.description ? String(contribution.description) : undefined,
              command: contribution.command.trim()
            })
          }
          resolve()
        })
      },
      onCommand(command, handler) {
        const name = String(command || '').trim()
        if (!name) throw new Error('UI command is required')
        state.commands.set(name, handler)
        return () => {
          if (state.commands.get(name) === handler) state.commands.delete(name)
        }
      },
      notify(notice) {
        return new Promise((resolve) => {
          if (notice && notice.message && state.notices.length < 8) {
            state.notices.push({ kind: notice.kind ? String(notice.kind) : 'info', message: String(notice.message).slice(0, 500) })
          }
          resolve()
        })
      }
    },
    overlay: { show: unavailable('twilight.overlay'), hide: unavailable('twilight.overlay'), configure: unavailable('twilight.overlay') },
    library: {
      importPlaylists: unavailable('twilight.library'),
      queryTracks: unavailable('twilight.library'),
      getTracksByIds: unavailable('twilight.library'),
      patchTracks: unavailable('twilight.library'),
      getCover: unavailable('twilight.library'),
      listPlaylists: unavailable('twilight.library'),
      createPlaylist: unavailable('twilight.library'),
      addTracksToPlaylist: unavailable('twilight.library'),
      removeTracksFromPlaylist: unavailable('twilight.library')
    },
    appSettings: { get: unavailable('twilight.appSettings'), update: unavailable('twilight.appSettings') },
    host: { captureScreenshot: unavailable('twilight.host') },
    experience: { onRequest: () => () => {}, emit() {} },
    themes: { register: unavailable('twilight.themes') }
  }

  const context = { apiVersion: 1, storagePath: '', platform: 'android', logger, settings, twilight }

  // ── Media capture ───────────────────────────────────────────────────────
  // Desktop providers hand the player http://127.0.0.1 proxy URLs. Android has
  // no loopback server: the proxy handler runs once against a fake request and
  // its upstream fetch is captured instead of performed, so the player can
  // open the CDN URL with the same headers itself.
  function captureUpstream(value, kind) {
    const target = virtualServerFor(value)
    if (!target) return Promise.resolve(null)
    return new Promise((resolve, reject) => {
      if (mediaCapture.active) throw new Error('媒体地址解析冲突')
      const controller = new AbortController()
      const capture = {
        done: false,
        matches(url, request) {
          if (isLoopbackHost(url.hostname)) return false
          // An image route fetches its picture first; a stream route may call APIs
          // first, so only the ranged (or media-host) request is the stream itself.
          if (kind === 'image') return true
          if (request.headers.has('range')) return true
          return hostMatches(state.mediaHosts, url.hostname) && !hostMatches(state.networkHosts, url.hostname)
        },
        onCapture(info) {
          const headers = info.headers.filter(([name]) => !DROPPED_MEDIA_HEADERS.has(name.toLowerCase()))
          resolve({ url: info.url, headers })
          controller.abort()
        }
      }
      mediaCapture.active = capture
      const request = new Request(target.url.href, {
        headers: kind === 'stream' ? { range: 'bytes=0-' } : { accept: 'image/*' },
        signal: controller.signal
      })
      target.server._dispatch(request, null).then(
        (response) => {
          if (capture.done) return
          const location = response.headers.get('location')
          if (response.status >= 300 && response.status < 400 && location && !virtualServerFor(new URL(location, target.url.href).href)) {
            resolve({ url: new URL(location, target.url.href).href, headers: [] })
          } else reject(new Error(`音源代理返回 HTTP ${response.status}`))
          if (response.body) response.body.cancel().catch(() => {})
        },
        (error) => {
          if (!capture.done) reject(error)
        }
      )
    }).finally(() => {
      mediaCapture.active = null
    })
  }

  function resolvePlayback(value) {
    const raw = value && typeof value === 'object' && typeof value.url === 'string' ? value.url : value
    if (raw === null || raw === undefined || raw === '') return Promise.resolve(null)
    if (typeof raw !== 'string') return Promise.reject(new Error('音源返回了无效的播放地址'))
    return captureUpstream(raw, 'stream').then((captured) => {
      if (captured) return captured
      if (!/^https?:\/\//i.test(raw)) throw new Error('音源返回了不支持的播放地址')
      const url = new URL(raw)
      upgradeToHttps(url)
      return { url: url.href, headers: [] }
    })
  }

  /** Replaces loopback image-proxy URLs anywhere in a result with their upstream URLs. */
  function rewriteLoopbackUrls(value) {
    const found = new Map()
    const visit = (node, depth) => {
      if (depth > 12 || found.size >= MAX_REWRITTEN_URLS) return
      if (typeof node === 'string') {
        if (!found.has(node) && virtualServerFor(node)) found.set(node, null)
      } else if (Array.isArray(node)) {
        for (const item of node) visit(item, depth + 1)
      } else if (node && typeof node === 'object') {
        for (const key of Object.keys(node)) visit(node[key], depth + 1)
      }
    }
    visit(value, 0)
    if (!found.size) return Promise.resolve(value)
    const urls = Array.from(found.keys())
    // One capture at a time: the capture slot is shared by every fetch.
    let chain = Promise.resolve()
    for (const url of urls) {
      chain = chain.then(() =>
        captureUpstream(url, 'image').then(
          (captured) => found.set(url, captured ? captured.url : null),
          () => found.set(url, null)
        )
      )
    }
    const replace = (node, depth) => {
      if (depth > 12) return node
      if (typeof node === 'string') return found.has(node) ? found.get(node) : node
      if (Array.isArray(node)) return node.map((item) => replace(item, depth + 1))
      if (node && typeof node === 'object') {
        const out = {}
        for (const key of Object.keys(node)) out[key] = replace(node[key], depth + 1)
        return out
      }
      return node
    }
    return chain.then(() => replace(value, 0))
  }

  function withQrImage(value) {
    if (!value || typeof value !== 'object') return value
    const image = typeof value.imageDataUrl === 'string' ? value.imageDataUrl : ''
    if (/^data:image\//i.test(image) || typeof value.qrContent !== 'string' || !value.qrContent) return value
    return { ...value, imageDataUrl: hostCall('qrImage', { text: value.qrContent }) }
  }

  // ── Operations ──────────────────────────────────────────────────────────
  function activate(request) {
    if (state.active) return Promise.resolve(describe())
    const manifest = request.manifest && typeof request.manifest === 'object' ? request.manifest : {}
    const runtime = manifest.androidRuntime && typeof manifest.androidRuntime === 'object' ? manifest.androidRuntime : {}
    state.manifest = manifest
    state.networkHosts = Array.isArray(runtime.networkHosts) ? runtime.networkHosts.map((host) => String(host).toLowerCase()) : []
    state.mediaHosts = Array.isArray(runtime.mediaHosts) ? runtime.mediaHosts.map((host) => String(host).toLowerCase()) : []
    transportPolicy.secureHosts = state.networkHosts.concat(state.mediaHosts)
    transportPolicy.cleartextHosts = Array.isArray(runtime.cleartextHosts) ? runtime.cleartextHosts.map((host) => String(host).toLowerCase()) : []
    return Promise.resolve()
      .then(() => (typeof options.setup === 'function' ? options.setup(context) : undefined))
      .then(() => plugin.activate(context))
      .then(() => {
        if (!state.provider) throw new Error('插件没有注册音源')
        if (options.methods) {
          for (const method of Object.keys(options.methods)) {
            const handler = options.methods[method]
            if (handler === null) delete state.handlers[method]
            else if (typeof handler === 'function' && method in PROVIDER_ARITY) state.handlers[method] = handler
          }
        }
        for (const method of options.exclude || []) delete state.handlers[method]
        if (options.ui) state.provider.ui = { ...state.provider.ui, ...options.ui }
        // `commands` may be a factory so Android-only commands can reuse the
        // plugin's own registered handlers (e.g. to back a native settings form).
        // registered() keeps answering with the plugin's handler after an
        // Android command of the same name replaces it.
        const own = new Map(state.commands)
        const registered = (name) => own.get(name)
        const commands = typeof options.commands === 'function' ? options.commands({ runCommand, registered }) : options.commands
        if (commands) {
          for (const name of Object.keys(commands)) {
            if (typeof commands[name] === 'function') state.commands.set(name, commands[name])
            else state.commands.delete(name)
          }
        }
        if (options.panels) state.panels = options.panels(state.panels.slice())
        state.panels = state.panels.filter((panel) => state.commands.has(panel.command))
        state.active = true
        return describe()
      })
  }

  function runCommand(name, ...args) {
    const handler = state.commands.get(name)
    if (typeof handler !== 'function') return Promise.reject(new Error(`插件没有注册命令 ${name}`))
    return Promise.resolve().then(() => handler(...args))
  }

  function describe() {
    return {
      apiVersion: 2,
      id: state.provider.id,
      name: state.provider.name,
      capabilities: state.provider.capabilities,
      methods: Object.keys(state.handlers),
      ui: state.provider.ui,
      panels: state.panels
    }
  }

  function callMethod(request, invocation) {
    if (!state.active) throw new Error('插件尚未启用')
    const method = String(request.method || '')
    const handler = state.handlers[method]
    if (typeof handler !== 'function') throw new Error(`音源不支持 ${method}`)
    // Extra arguments are kept: streaming sections (ui.streamingSections) call
    // methods with their own args, e.g. fetchRecommendSongs('discover').
    const args = (Array.isArray(request.args) ? request.args.slice(0, MAX_CALL_ARGS) : []).map((arg) => (arg === null ? undefined : arg))
    while (args.length < PROVIDER_ARITY[method]) args.push(undefined)
    return Promise.resolve(handler(...args, invocation)).then((value) => {
      if (method === 'getPlaybackUrl') return resolvePlayback(value)
      if (method === 'getQrLogin') value = withQrImage(value)
      return rewriteLoopbackUrls(value)
    })
  }

  function callCommand(request, invocation) {
    if (!state.active) throw new Error('插件尚未启用')
    const handler = state.commands.get(String(request.command || ''))
    if (typeof handler !== 'function') throw new Error(`插件没有注册命令 ${request.command}`)
    const args = Array.isArray(request.args) ? request.args : []
    return Promise.resolve(handler(...args, invocation))
  }

  function deactivate() {
    const wasActive = state.active
    state.active = false
    const done = wasActive && typeof plugin.deactivate === 'function' ? Promise.resolve(plugin.deactivate()) : Promise.resolve()
    return done.then(() => {
      for (const [port, server] of Array.from(virtualServers)) {
        virtualServers.delete(port)
        server.listening = false
      }
      return null
    })
  }

  function dispatch(request, invocation) {
    switch (request.operation) {
      case 'activate':
        return activate(request)
      case 'call':
        return callMethod(request, invocation)
      case 'command':
        return callCommand(request, invocation)
      case 'resolveMedia':
        return request.kind === 'image'
          ? captureUpstream(String(request.url || ''), 'image')
          : resolvePlayback(String(request.url || ''))
      case 'deactivate':
        return deactivate()
      case 'ping':
        return Promise.resolve('pong')
      default:
        throw new Error(`未知的插件请求：${request.operation}`)
    }
  }

  function invoke(text) {
    let request
    try {
      request = JSON.parse(String(text))
    } catch {
      return JSON.stringify({ ok: false, error: '插件请求格式无效' })
    }
    resetLogBudget()
    state.notices = []
    // Deliver socket frames and timers that came due between calls first.
    try {
      pump(1000)
    } catch (error) {
      hostLog('warn', ['插件后台任务失败', error])
    }
    const controller = new AbortController()
    const invocation = { signal: controller.signal }
    if (typeof request.idempotencyKey === 'string') invocation.idempotencyKey = request.idempotencyKey
    let outcome = null
    let promise
    try {
      promise = Promise.resolve(dispatch(request, invocation))
    } catch (error) {
      promise = Promise.reject(error)
    }
    promise.then(
      (value) => {
        outcome = { ok: true, value: value === undefined ? null : value }
      },
      (error) => {
        outcome = { ok: false, error: errorMessage(error) }
      }
    )
    const deadline = Math.min(MAX_DEADLINE_MS, Math.max(1000, Number(request.deadlineMs) || DEFAULT_DEADLINE_MS))
    try {
      run(() => outcome !== null, deadline)
    } catch (error) {
      if (!outcome) {
        controller.abort(new Error(errorMessage(error)))
        outcome = { ok: false, error: errorMessage(error) }
      }
    }
    if (state.notices.length) outcome.notices = state.notices
    try {
      return JSON.stringify(outcome)
    } catch (error) {
      return JSON.stringify({ ok: false, error: `插件返回值无法序列化：${errorMessage(error)}` })
    }
  }

  globalThis.__TWILIGHT_ON_ERROR__ = (error) => hostLog('error', ['插件未处理的错误', error])
  const abi = { apiVersion: 2, invoke }
  globalThis.__TWILIGHT_PLUGIN__ = abi
  return abi
}
