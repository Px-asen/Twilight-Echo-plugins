import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createCipheriv, createHash, createHmac } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { gzipSync } from 'node:zlib'
import { buildAndroidPlugin, validateAndroidRuntime } from './build.mjs'
import { createHarness } from './harness.mjs'

const SDK_ROOT = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(SDK_ROOT, '..', '..')
const PROVIDER_MODULE = path.join(SDK_ROOT, 'provider.js').replace(/\\/g, '/')
const RUNTIME = {
  apiVersion: 2,
  entry: 'android/provider.js',
  permissions: ['network', 'settings'],
  networkHosts: ['api.example.com', 'legacy.example.com', 'ws.example.com'],
  mediaHosts: ['*.example.net'],
  cleartextHosts: ['legacy.example.com']
}

const roots = []
const harnesses = []
after(async () => {
  await Promise.all(harnesses.map((harness) => harness.close()))
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
})

/**
 * Builds a throwaway provider plugin: `index` is the desktop entry (index.mjs),
 * `android` the body of android.mjs after its imports.
 */
async function load(index, { android = 'defineAndroidProvider(plugin)', runtime = RUNTIME, ...options } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'twilight-android-sdk-'))
  roots.push(root)
  const manifest = {
    id: 'com.example.fixture',
    name: 'Fixture',
    version: '1.0.0',
    description: 'SDK fixture',
    author: 'Twilight Echo',
    license: 'Apache-2.0',
    type: ['provider'],
    main: 'index.mjs',
    engines: { twilightEcho: '>=1.0.0' },
    apiVersion: 1,
    permissions: ['network', 'settings'],
    androidRuntime: runtime
  }
  await writeFile(path.join(root, 'plugin.json'), JSON.stringify(manifest))
  await writeFile(path.join(root, 'index.mjs'), index)
  await writeFile(
    path.join(root, 'android.mjs'),
    `import { defineAndroidProvider } from ${JSON.stringify(PROVIDER_MODULE)}\nimport * as plugin from './index.mjs'\n${android}\n`
  )
  const harness = await createHarness(root, options)
  harnesses.push(harness)
  return harness
}

/** A desktop provider module whose provider object has `members`. */
function provider(members, { imports = '', setup = '' } = {}) {
  return `${imports}
export async function activate(context) {
  ${setup}
  await context.twilight.providers.register({ id: 'fixture', name: 'Fixture', capabilities: ['search'], ${members} })
}
`
}

test('the runtime gives desktop code its web globals and ES2021+ built-ins on QuickJS 2020', async () => {
  const harness = await load(
    provider(`
    async searchSongs() {
      const order = []
      setTimeout(() => order.push('timeout'), 0)
      setImmediate(() => order.push('immediate'))
      queueMicrotask(() => order.push('microtask'))
      Promise.resolve().then(() => order.push('promise'))
      await new Promise((resolve) => setTimeout(resolve, 20))
      const cloned = structuredClone({ map: new Map([[1, { list: [1, 2] }]]), date: new Date(0) })
      return {
        order,
        builtins: [[1, 2, 3].at(-1), [1, 2, 3].findLast((n) => n < 3), Object.hasOwn({ a: 1 }, 'a'), 'a-b'.replaceAll('-', '+'), [3, 1, 2].toSorted()],
        cloned: [cloned.map.get(1).list[1], cloned.date.getTime()],
        text: new TextDecoder().decode(new TextEncoder().encode('晴天')),
        base64: [Buffer.from('晴天').toString('base64'), btoa('hi'), atob('aGk=')],
        url: new URL('/path?q=1', 'https://api.example.com').searchParams.get('q'),
        uuid: crypto.randomUUID(),
        node: [typeof process.nextTick, typeof global, typeof performance.now()]
      }
    }`)
  )
  harness.activate()
  const value = harness.call('searchSongs', 'q')
  assert.deepEqual(value.order.slice(0, 2), ['microtask', 'promise'])
  assert.deepEqual(value.order.slice(2).sort(), ['immediate', 'timeout'])
  assert.deepEqual(value.builtins, [3, 2, true, 'a+b', [1, 2, 3]])
  assert.deepEqual(value.cloned, [2, 0])
  assert.equal(value.text, '晴天')
  assert.deepEqual(value.base64, [Buffer.from('晴天').toString('base64'), 'aGk=', 'hi'])
  assert.equal(value.url, '1')
  assert.match(value.uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  assert.deepEqual(value.node, ['function', 'object', 'number'])
})

test('fetch runs through the host: chunked and binary bodies, redirects, grants and the HTTPS upgrade', async () => {
  const large = 'x'.repeat(300_000)
  const routes = (request) => {
    const url = new URL(request.url)
    switch (url.pathname) {
      case '/json':
        return { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ok: true }) }
      case '/large':
        return { headers: { 'content-type': 'text/plain' }, body: large }
      case '/png':
        return { headers: { 'content-type': 'image/png' }, body: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 255]) }
      case '/hop':
        return { status: 302, headers: { location: 'https://cdn.example.net/final' } }
      case '/final':
        return { body: 'final' }
      case '/escape':
        return { status: 302, headers: { location: 'https://evil.example.org/' } }
      case '/scheme':
        return { body: url.protocol }
      default:
        return { status: 404, body: 'missing' }
    }
  }
  const harness = await load(
    provider(`
    async searchSongs() {
      const attempt = (url) => fetch(url).then((response) => response.text(), (error) => 'error: ' + (error.cause ? error.cause.message : error.message))
      const json = await (await fetch('https://api.example.com/json', { headers: { 'X-Test': 'yes', 'Accept-Encoding': 'br' } })).json()
      const hop = await fetch('https://api.example.com/hop')
      return {
        json,
        large: (await (await fetch('https://api.example.com/large')).text()).length,
        png: Array.from(new Uint8Array(await (await fetch('https://api.example.com/png')).arrayBuffer())),
        hop: [hop.url, hop.redirected, await hop.text()],
        missing: (await fetch('https://api.example.com/nope')).status,
        escape: await attempt('https://api.example.com/escape'),
        upgraded: await attempt('http://api.example.com/scheme'),
        cleartext: await attempt('http://legacy.example.com/scheme'),
        insecure: await attempt('http://other.example.com/scheme'),
        undeclared: await attempt('https://other.example.com/scheme')
      }
    },
    async getLyrics() {
      await fetch('https://other.example.com/lyrics')
    }`),
    { routes }
  )
  harness.activate()
  const value = harness.call('searchSongs', 'q')
  assert.deepEqual(value.json, { ok: true })
  assert.equal(value.large, large.length)
  assert.deepEqual(value.png, [0x89, 0x50, 0x4e, 0x47, 0, 255])
  assert.deepEqual(value.hop, ['https://cdn.example.net/final', true, 'final'])
  assert.equal(value.missing, 404)
  assert.equal(value.escape, 'error: 插件未获准访问 evil.example.org')
  assert.equal(value.upgraded, 'https:')
  assert.equal(value.cleartext, 'http:')
  assert.equal(value.insecure, 'error: 插件只能通过 HTTPS 访问 other.example.com')
  assert.equal(value.undeclared, 'error: 插件未获准访问 other.example.com')
  const sent = harness.host.requests.find((request) => request.url.endsWith('/json'))
  assert.deepEqual(sent.headers, [['x-test', 'yes']])
  // A transport failure reaches the app as the host's reason, not "fetch failed".
  assert.throws(() => harness.call('getLyrics', {}), { message: '插件未获准访问 other.example.com' })
})

test('node:crypto, node:zlib and ES5-style stream and event subclasses behave like Node', async () => {
  const harness = await load(
    provider(
      `
    async searchSongs() {
      function Sink() { Writable.call(this); this.chunks = [] }
      util.inherits(Sink, Writable)
      Sink.prototype._write = function (chunk, encoding, callback) { this.chunks.push(String(chunk)); callback() }
      function Bus() { EventEmitter.call(this) }
      util.inherits(Bus, EventEmitter)
      function Inflater(options) { zlib.Inflate.call(this, options) }
      util.inherits(Inflater, zlib.Inflate)
      const collect = (stream) => new Promise((resolve, reject) => {
        const parts = []
        stream.on('data', (chunk) => parts.push(Buffer.from(chunk)))
        stream.on('end', () => resolve(Buffer.concat(parts).toString()))
        stream.on('error', reject)
      })

      const sink = new Sink()
      const finished = new Promise((resolve) => sink.on('finish', resolve))
      sink.write('a')
      sink.end('b')
      await finished
      const bus = new Bus()
      let heard = null
      bus.on('ping', (value) => { heard = value })
      bus.emit('ping', 42)
      const inflater = new Inflater()
      const inflated = collect(inflater)
      inflater.end(zlib.deflateSync('inflated'))
      const gunzip = zlib.createGunzip()
      const gunzipped = collect(gunzip)
      Readable.from([Buffer.from(gzipped, 'base64')]).pipe(gunzip)
      const key = Buffer.alloc(16, 7)
      const cipher = crypto.createCipheriv('aes-128-ecb', key, null)
      const encrypted = Buffer.concat([cipher.update('secret'), cipher.final()])
      const decipher = crypto.createDecipheriv('aes-128-ecb', key, null)
      let brotli = null
      try { zlib.brotliDecompressSync(Buffer.alloc(4)) } catch (error) { brotli = error.message }
      return {
        sink: sink.chunks.join(''),
        heard,
        duplexIsWritable: new Duplex() instanceof Writable,
        transformIsDuplex: new Transform() instanceof Duplex,
        inflated: await inflated,
        gunzipped: await gunzipped,
        sync: zlib.gunzipSync(zlib.gzipSync('round trip')).toString(),
        md5: crypto.createHash('md5').update('abc').digest('hex'),
        hmac: crypto.createHmac('sha256', 'key').update('data').digest('base64'),
        encrypted: encrypted.toString('hex'),
        decrypted: Buffer.concat([decipher.update(encrypted), decipher.final()]).toString(),
        random: crypto.randomBytes(16).length,
        brotli
      }
    }`,
      {
        imports: `import crypto from 'node:crypto'
import { EventEmitter } from 'node:events'
import { Duplex, Readable, Transform, Writable } from 'node:stream'
import util from 'node:util'
import zlib from 'node:zlib'
const gzipped = ${JSON.stringify(gzipSync('gunzipped').toString('base64'))}`
      }
    )
  )
  harness.activate()
  const value = harness.call('searchSongs', 'q')
  const cipher = createCipheriv('aes-128-ecb', Buffer.alloc(16, 7), null)
  assert.deepEqual(value, {
    sink: 'ab',
    heard: 42,
    duplexIsWritable: true,
    transformIsDuplex: true,
    inflated: 'inflated',
    gunzipped: 'gunzipped',
    sync: 'round trip',
    md5: createHash('md5').update('abc').digest('hex'),
    hmac: createHmac('sha256', 'key').update('data').digest('base64'),
    encrypted: Buffer.concat([cipher.update('secret'), cipher.final()]).toString('hex'),
    decrypted: 'secret',
    random: 16,
    // Android has no Brotli codec.
    brotli: '不支持的压缩方式 brotliDecompress'
  })
})

test('loopback proxy URLs resolve to the upstream request the player opens itself', async () => {
  const harness = await load(
    provider(
      `
    async searchSongs() {
      return { items: [{ id: 'fixture:1', coverUrl: 'http://127.0.0.1:' + port + '/cover?id=1' }] }
    },
    async fetchPersonalFm() {
      return { port: String(port) }
    },
    async getPlaybackUrl(track) {
      return { url: 'http://127.0.0.1:' + port + '/' + track.path }
    }`,
      {
        imports: `import http from 'node:http'
let port = 0`,
        setup: `const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    if (url.pathname === '/stream') {
      const upstream = await fetch('https://cdn.example.net/song.flac', { headers: { range: request.headers.range || 'bytes=0-', referer: 'https://api.example.com/' } })
      response.writeHead(upstream.status, { 'content-type': 'audio/flac' })
      response.end(Buffer.from(await upstream.arrayBuffer()))
    } else if (url.pathname === '/cover') {
      const upstream = await fetch('https://img.example.net/cover.jpg')
      response.writeHead(200, { 'content-type': 'image/jpeg' })
      response.end(Buffer.from(await upstream.arrayBuffer()))
    } else if (url.pathname === '/redirect') {
      response.writeHead(302, { location: 'https://cdn.example.net/redirected.mp3' })
      response.end()
    } else {
      response.writeHead(404)
      response.end()
    }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = server.address().port`
      }
    )
  )
  harness.activate()
  assert.deepEqual(harness.call('getPlaybackUrl', { path: 'stream' }, {}), {
    url: 'https://cdn.example.net/song.flac',
    headers: [['referer', 'https://api.example.com/']]
  })
  assert.deepEqual(harness.call('getPlaybackUrl', { path: 'redirect' }, {}), { url: 'https://cdn.example.net/redirected.mp3', headers: [] })
  assert.throws(() => harness.call('getPlaybackUrl', { path: 'gone' }, {}), { message: '音源代理返回 HTTP 404' })
  assert.equal(harness.call('searchSongs', 'q').items[0].coverUrl, 'https://img.example.net/cover.jpg')
  const { port } = harness.call('fetchPersonalFm')
  assert.equal(harness.resolveMedia(`http://127.0.0.1:${port}/cover?id=2`, 'image').url, 'https://img.example.net/cover.jpg')
  // Captured requests are handed over, never performed by the plugin.
  assert.deepEqual(harness.host.requests, [])
})

test('the provider adapter keeps the desktop calling convention and maps settings, QR and notices', async () => {
  const harness = await load(
    provider(
      `
    ui: { qrStatusCodes: { waiting: 1, success: 4 } },
    async searchSongs(...args) {
      return { count: args.length, query: args[0], signal: typeof args[args.length - 1].signal }
    },
    async fetchRecommendSongs(...args) {
      return args.slice(0, -1)
    },
    async getQrLogin() {
      return { key: 'qr-key', qrContent: 'https://login.example.com/qr?k=1' }
    },
    async checkLogin() {
      await context.twilight.ui.notify({ kind: 'warning', message: '登录已过期' })
      return { loggedIn: false }
    },
    getLyrics() {
      return new Promise((resolve) => setTimeout(resolve, 60000))
    },
    async getPlaybackUrl(track) {
      return track.value
    },
    async fetchToplists() {
      throw new Error('upstream failed')
    },
    openOfficialLogin() {}`,
      {
        setup: `context.twilight.ui.onCommand('fixture.settings', async (values) => ({ kind: 'settings-form', submitCommand: 'fixture.settings', fields: [{ key: 'token' }, { key: 'desktopOnly' }], values }))
  context.twilight.ui.onCommand('fixture.extra', async () => 'extra')
  await context.twilight.ui.register({ kind: 'settingsPanel', id: 'settings', title: '设置', command: 'fixture.settings' })
  await context.twilight.ui.register({ kind: 'settingsPanel', id: 'orphan', title: '孤立', command: 'fixture.missing' })`
      }
    ),
    {
      android: `defineAndroidProvider(plugin, {
  commands: ({ registered }) => ({
    async 'fixture.settings'(values, ...rest) {
      const form = await registered('fixture.settings')(values, ...rest)
      return { ...form, fields: form.fields.filter((field) => field.key !== 'desktopOnly') }
    },
    'fixture.extra': null
  })
})`
    }
  )
  const info = harness.activate()
  assert.equal(info.apiVersion, 2)
  assert.equal(info.id, 'fixture')
  assert.deepEqual(info.ui, { qrStatusCodes: { waiting: 1, success: 4 } })
  assert.equal(info.methods.includes('openOfficialLogin'), false)
  assert.deepEqual(info.panels, [{ id: 'settings', title: '设置', command: 'fixture.settings' }])

  const form = harness.command('fixture.settings', { token: 't' })
  assert.deepEqual(form.fields, [{ key: 'token' }])
  assert.deepEqual(form.values, { token: 't' })
  assert.throws(() => harness.command('fixture.extra'), { message: '插件没有注册命令 fixture.extra' })

  // Calls are padded to the desktop arity; the invocation context comes last.
  assert.deepEqual(harness.call('searchSongs', 'q'), { count: 4, query: 'q', signal: 'object' })
  // Streaming sections pass their own extra arguments.
  assert.deepEqual(harness.call('fetchRecommendSongs', 'daily'), ['daily'])

  const qr = harness.call('getQrLogin')
  assert.match(qr.imageDataUrl, /^data:image\/png;base64,/)
  assert.deepEqual(harness.host.qrTexts, ['https://login.example.com/qr?k=1'])

  const envelope = harness.invoke({ operation: 'call', method: 'checkLogin', args: [] })
  assert.deepEqual(envelope, { ok: true, value: { loggedIn: false }, notices: [{ kind: 'warning', message: '登录已过期' }] })

  assert.deepEqual(harness.call('getPlaybackUrl', { value: 'http://cdn.example.net/a.mp3' }, {}), { url: 'https://cdn.example.net/a.mp3', headers: [] })
  assert.equal(harness.call('getPlaybackUrl', { value: null }, {}), null)
  assert.throws(() => harness.call('getPlaybackUrl', { value: 'file:///sdcard/a.mp3' }, {}), { message: '音源返回了不支持的播放地址' })

  const started = Date.now()
  assert.deepEqual(harness.invoke({ operation: 'call', method: 'getLyrics', args: [{}], deadlineMs: 1000 }), { ok: false, error: '插件调用超时' })
  assert.ok(Date.now() - started < 5000)
  assert.throws(() => harness.call('fetchToplists'), { message: 'upstream failed' })
  assert.throws(() => harness.call('nope'), { message: '音源不支持 nope' })
  assert.equal(harness.invoke({ operation: 'ping' }).value, 'pong')
  assert.deepEqual(harness.invoke({ operation: 'bogus' }), { ok: false, error: '未知的插件请求：bogus' })
  harness.deactivate()
  assert.throws(() => harness.call('searchSongs', 'q'), { message: '插件尚未启用' })
})

test('WebSockets use the host socket API', async () => {
  const harness = await load(
    provider(`
    searchSongs() {
      const socket = new WebSocket('wss://ws.example.com/socket')
      return new Promise((resolve, reject) => {
        socket.onopen = () => socket.send('hello')
        socket.onmessage = (event) => {
          socket.close()
          resolve(event.data)
        }
        socket.onerror = () => reject(new Error('socket failed'))
      })
    }`),
    {
      webSockets: () => ({
        open: (socket) => socket.emit({ type: 'open', protocol: '' }),
        send: (text, socket) => socket.emit({ type: 'message', text: `echo:${text}` })
      })
    }
  )
  harness.activate()
  assert.equal(harness.call('searchSongs', 'q'), 'echo:hello')
})

test('androidRuntime validation matches what the Android app accepts', () => {
  const manifest = (runtime, type = ['provider']) => ({ id: 'com.example.fixture', type, androidRuntime: { ...RUNTIME, ...runtime } })
  assert.doesNotThrow(() => validateAndroidRuntime(manifest({})))
  assert.doesNotThrow(() => validateAndroidRuntime(manifest({ networkHosts: [], mediaHosts: [], cleartextHosts: [], userServer: true })))
  for (const [runtime, type] of [
    [{ apiVersion: 1 }],
    [{}, ['tool', 'ui']],
    [{ entry: '../provider.js' }],
    [{ entry: '/provider.js' }],
    [{ permissions: ['filesystem:read'] }],
    [{ networkHosts: [] }],
    [{ networkHosts: ['*.example.com'] }],
    [{ networkHosts: ['192.168.1.2'] }],
    [{ mediaHosts: ['*.com'] }],
    [{ cleartextHosts: ['plain.example.org'] }],
    [{ cleartextHosts: ['*.example.net'] }],
    [{ userServer: 'yes' }]
  ]) {
    assert.throws(() => validateAndroidRuntime(manifest(runtime, type)), /androidRuntime/, JSON.stringify(runtime))
  }
})

test('every provider package ships the Android script built from its source, and only providers declare one', async () => {
  const execute = promisify(execFile)
  const unzip =
    process.platform === 'linux'
      ? (archive, name) => execute('unzip', ['-p', archive, name], { maxBuffer: 64 << 20 })
      : (archive, name) => execute(process.platform === 'win32' ? 'C:/Windows/System32/tar.exe' : 'tar', ['-xOf', archive, name], { maxBuffer: 64 << 20 })
  let providers = 0
  for (const name of await readdir(path.join(REPO_ROOT, 'plugins'))) {
    const pluginRoot = path.join(REPO_ROOT, 'plugins', name)
    const manifest = JSON.parse(await readFile(path.join(pluginRoot, 'plugin.json'), 'utf8'))
    if (!manifest.type.includes('provider')) {
      assert.equal(manifest.androidRuntime, undefined, `${manifest.id} is not a provider`)
      continue
    }
    if (!manifest.androidRuntime) continue
    providers++
    const archive = path.join(REPO_ROOT, 'packages', `${manifest.id}-${manifest.version}.tep`)
    const { stdout } = await unzip(archive, manifest.androidRuntime.entry)
    const { code } = await buildAndroidPlugin(pluginRoot)
    assert.equal(stdout, code, `${manifest.id}: repack after changing android.mjs, the provider or sdk/android`)
  }
  assert.ok(providers > 0)
})
