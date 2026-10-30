#!/usr/bin/env node
// Builds a provider plugin's Android entry (android.mjs) into the single
// QuickJS script the Android worker loads (androidRuntime.entry, ABI v2).
//
//   node sdk/android/build.mjs plugins/navidrome-provider [--out <file>]
import { build } from 'esbuild'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SDK_ROOT = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(SDK_ROOT, '..', '..')
const sdk = (file) => path.join(SDK_ROOT, file).replace(/\\/g, '/')

/** Largest script the worker stages (characters). */
export const MAX_ANDROID_SCRIPT_CHARS = 4_000_000

const HOST = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/
const HOST_LIMITS = { networkHosts: 48, mediaHosts: 32, cleartextHosts: 16 }

function hostCovered(patterns, host) {
  return patterns.some((pattern) => (pattern.startsWith('*.') ? host.endsWith(pattern.slice(1)) : pattern === host))
}

/**
 * The androidRuntime rules the Android app enforces before it installs a
 * package (Twilight_Echo src/core/plugins/mobileRepository.ts), checked at
 * build time so a package never ships a runtime the app refuses.
 */
export function validateAndroidRuntime(manifest) {
  const runtime = manifest.androidRuntime
  const fail = (message) => {
    throw new Error(`${manifest.id}: androidRuntime ${message}`)
  }
  if (!runtime || typeof runtime !== 'object' || runtime.apiVersion !== 2) fail('需要 apiVersion 2')
  const type = Array.isArray(manifest.type) ? manifest.type : []
  if (!type.includes('provider') || type.some((item) => item !== 'provider' && item !== 'ui')) fail('只适用于音源插件')
  if (typeof runtime.entry !== 'string' || !/^[\w-]+(?:\/[\w-]+)*\.js$/.test(runtime.entry)) fail('entry 无效')
  if (!Array.isArray(runtime.permissions) || runtime.permissions.some((item) => item !== 'network' && item !== 'settings'))
    fail('permissions 只能包含 network 与 settings')
  for (const [key, limit] of Object.entries(HOST_LIMITS)) {
    const hosts = runtime[key] === undefined && key !== 'networkHosts' ? [] : runtime[key]
    if (!Array.isArray(hosts) || hosts.length > limit) fail(`${key} 必须是不超过 ${limit} 项的数组`)
    for (const host of hosts) {
      // Only media hosts may name every subdomain of a registrable domain.
      const wildcard = key === 'mediaHosts' && typeof host === 'string' && host.startsWith('*.')
      const name = wildcard ? host.slice(2) : host
      if (typeof name !== 'string' || !HOST.test(name) || (wildcard && name.split('.').length < 2))
        fail(`${key} 包含无效主机名 ${String(host)}`)
    }
  }
  if (runtime.userServer !== undefined && typeof runtime.userServer !== 'boolean') fail('userServer 必须是布尔值')
  if (!runtime.userServer && !runtime.networkHosts.length) fail('需要 networkHosts 或 userServer')
  const granted = [...runtime.networkHosts, ...(runtime.mediaHosts || [])]
  for (const host of runtime.cleartextHosts || []) {
    if (!hostCovered(granted, host)) fail(`cleartextHosts 中的 ${host} 未在 networkHosts 或 mediaHosts 中授权`)
  }
}

// Node built-ins → SDK shims. Each resolves to a small CommonJS wrapper so
// both `require('events')` and `import { EventEmitter } from 'node:events'`
// see Node's module.exports shape (the shim's default export plus its names).
const SHIMS = {
  assert: 'node/assert.js',
  async_hooks: 'node/async_hooks.js',
  buffer: 'node/buffer.js',
  crypto: 'node/crypto.js',
  events: 'node/events.js',
  fs: 'node/fs.js',
  'fs/promises': 'node/fs-promises.js',
  http: 'node/http.js',
  https: 'node/https.js',
  net: 'node/net.js',
  os: 'node/os.js',
  path: 'node/path.js',
  process: 'node/process.js',
  querystring: 'node/querystring.js',
  stream: 'node/stream.js',
  string_decoder: 'node/string_decoder.js',
  timers: 'node/timers.js',
  'timers/promises': 'node/timers-promises.js',
  url: 'node/url.js',
  util: 'node/util.js',
  vm: 'node/vm.js',
  zlib: 'node/zlib.js'
}

/** Built-ins exposed as one property of a shim module. */
const PROPERTIES = {
  'assert/strict': ['node/assert.js', 'strict'],
  'path/posix': ['node/path.js', 'posix'],
  'stream/promises': ['node/stream.js', 'promises'],
  'util/types': ['node/util.js', 'types'],
  'dns/promises': ['node/unavailable.js', 'dns', 'promises'],
  tty: ['node/unavailable.js', 'tty'],
  child_process: ['node/unavailable.js', 'childProcess'],
  dns: ['node/unavailable.js', 'dns'],
  perf_hooks: ['node/unavailable.js', 'perfHooks'],
  worker_threads: ['node/unavailable.js', 'workerThreads'],
  tls: ['node/unavailable.js', 'tls'],
  readline: ['node/unavailable.js', 'readline'],
  http2: ['node/unavailable.js', 'http2'],
  cluster: ['node/unavailable.js', 'cluster'],
  v8: ['node/unavailable.js', 'v8'],
  module: ['node/unavailable.js', 'module'],
  diagnostics_channel: ['node/unavailable.js', 'diagnosticsChannel'],
  electron: ['node/unavailable.js', 'electron']
}

function wrapperSource(name) {
  if (SHIMS[name]) {
    return [
      `var ns = require(${JSON.stringify(sdk(SHIMS[name]))});`,
      'var out = ns.default !== undefined ? ns.default : {};',
      'Object.keys(ns).forEach(function (key) { if (key !== "default" && !(key in out)) out[key] = ns[key]; });',
      'module.exports = out;'
    ].join('\n')
  }
  if (name === 'stream/web') {
    return `var f = require(${JSON.stringify(sdk('runtime/fetch.js'))}); module.exports = { ReadableStream: f.ReadableStream };`
  }
  const [file, ...keys] = PROPERTIES[name]
  return `module.exports = require(${JSON.stringify(sdk(file))})${keys.map((key) => `[${JSON.stringify(key)}]`).join('')};`
}

function nodeBuiltinsPlugin() {
  return {
    name: 'twilight-node-builtins',
    setup(builder) {
      builder.onResolve({ filter: /^(node:)?[a-z_/]+$/ }, (args) => {
        const name = args.path.replace(/^node:/, '')
        if (SHIMS[name] || PROPERTIES[name] || name === 'stream/web') return { path: name, namespace: 'twilight-node' }
        if (args.path.startsWith('node:')) return { errors: [{ text: `Android 插件运行时没有提供 ${args.path}` }] }
        return undefined
      })
      builder.onLoad({ filter: /.*/, namespace: 'twilight-node' }, (args) => ({
        contents: wrapperSource(args.path),
        loader: 'js',
        resolveDir: SDK_ROOT
      }))
    }
  }
}

async function readManifest(pluginRoot) {
  const manifest = JSON.parse(await fs.readFile(path.join(pluginRoot, 'plugin.json'), 'utf8'))
  if (!manifest.androidRuntime) throw new Error(`${manifest.id}: plugin.json 缺少 androidRuntime`)
  validateAndroidRuntime(manifest)
  return manifest
}

/** Bundles <pluginRoot>/android.mjs. Returns the script text; writes it when `outfile` is given. */
export async function buildAndroidPlugin(pluginRoot, { outfile, minify = true } = {}) {
  const root = path.resolve(pluginRoot)
  const entry = path.join(root, 'android.mjs')
  if (!existsSync(entry)) throw new Error(`${root} 缺少 android.mjs`)
  const manifest = await readManifest(root)
  const result = await build({
    stdin: {
      // The runtime installs globals before any plugin module evaluates.
      contents: `import ${JSON.stringify(sdk('runtime/index.js'))};\nimport ${JSON.stringify(entry.replace(/\\/g, '/'))};\n`,
      resolveDir: root,
      sourcefile: `${manifest.id}/android-entry.js`,
      loader: 'js'
    },
    // Module ids in the bundle are relative to this root, so the same sources
    // build to the same script wherever the build runs from.
    absWorkingDir: REPO_ROOT,
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'neutral',
    mainFields: ['module', 'main'],
    conditions: ['import', 'require', 'default'],
    // QuickJS 2020-11. Async code is lowered onto the runtime's Promise so the
    // worker, not the engine's job queue, decides when continuations run.
    target: 'es2020',
    supported: { 'async-await': false, 'async-generator': false, 'for-await': false },
    charset: 'utf8',
    legalComments: 'eof',
    minifyWhitespace: minify,
    minifySyntax: minify,
    // CommonJS modules resolve bundled assets from __dirname; the plugin's
    // virtual fs answers those paths with ENOENT.
    define: {
      'process.env.NODE_ENV': '"production"',
      'import.meta.url': '"file:///android/provider.js"',
      __dirname: '"/android"',
      __filename: '"/android/provider.js"'
    },
    banner: { js: `/* ${manifest.id} ${manifest.version} · Twilight Echo Android ABI v2 */` },
    logLevel: 'silent',
    plugins: [nodeBuiltinsPlugin()]
  })
  const code = result.outputFiles[0].text
  if (code.length > MAX_ANDROID_SCRIPT_CHARS) throw new Error(`${manifest.id}: Android 脚本过大（${code.length} 字符）`)
  if (outfile) {
    await fs.mkdir(path.dirname(outfile), { recursive: true })
    await fs.writeFile(outfile, code, 'utf8')
  }
  return { code, manifest, warnings: result.warnings }
}

async function main() {
  const args = process.argv.slice(2)
  const pluginRoot = args.find((arg) => !arg.startsWith('--'))
  if (!pluginRoot) throw new Error('Usage: node sdk/android/build.mjs <plugin-directory> [--out <file>] [--no-minify]')
  const outIndex = args.indexOf('--out')
  const manifest = await readManifest(path.resolve(pluginRoot))
  const outfile = path.resolve(outIndex >= 0 ? args[outIndex + 1] : path.join('.cache', 'android', manifest.id, manifest.androidRuntime.entry))
  const { code, warnings } = await buildAndroidPlugin(pluginRoot, { outfile, minify: !args.includes('--no-minify') })
  for (const warning of warnings) console.warn(`warning: ${warning.text}`)
  console.log(`Built ${outfile} (${code.length} chars)`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
