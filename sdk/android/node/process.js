import { EventEmitter } from './events.js'
import { queueMicrotask } from '../runtime/loop.js'

// node:process. One instance is installed as globalThis.process.
const startedAt = Date.now()

const processObject = new EventEmitter()

Object.assign(processObject, {
  title: 'twilight-plugin',
  version: 'v20.0.0',
  versions: { node: '20.0.0', twilight: 'android' },
  arch: 'arm64',
  platform: 'android',
  release: { name: 'node' },
  env: { NODE_ENV: 'production' },
  argv: ['/system/bin/twilight', 'plugin'],
  execArgv: [],
  execPath: '/system/bin/twilight',
  pid: 1,
  ppid: 0,
  exitCode: undefined,
  browser: false,
  config: { variables: {} },
  features: {},
  stdout: { write() { return true }, isTTY: false, columns: 80, on() {} },
  stderr: { write() { return true }, isTTY: false, columns: 80, on() {} },
  stdin: { isTTY: false, on() {} },
  cwd: () => '/',
  chdir() {},
  umask: () => 0o22,
  uptime: () => (Date.now() - startedAt) / 1000,
  hrtime: Object.assign(
    (previous) => {
      const now = Date.now()
      const seconds = Math.floor(now / 1000)
      const nanos = (now % 1000) * 1e6
      if (!previous) return [seconds, nanos]
      let s = seconds - previous[0]
      let n = nanos - previous[1]
      if (n < 0) {
        s -= 1
        n += 1e9
      }
      return [s, n]
    },
    { bigint: () => BigInt(Date.now()) * BigInt(1000000) }
  ),
  memoryUsage: Object.assign(() => ({ rss: 0, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 }), { rss: () => 0 }),
  cpuUsage: () => ({ user: 0, system: 0 }),
  nextTick(callback, ...args) {
    queueMicrotask(() => callback(...args))
  },
  emitWarning() {},
  binding() {
    throw new Error('process.binding is not supported')
  },
  exit() {
    throw new Error('process.exit is not supported in Twilight plugins')
  },
  abort() {
    throw new Error('process.abort is not supported in Twilight plugins')
  },
  kill() {
    throw new Error('process.kill is not supported in Twilight plugins')
  },
  getuid: () => 0,
  getgid: () => 0,
  geteuid: () => 0,
  getegid: () => 0
})

export default processObject
