// Modules that have no Android equivalent. Importing them works; using them
// throws a clear error (or behaves as an inert stub where libraries only probe).
function unavailable(name) {
  return () => {
    throw new Error(`${name} 在 Android 插件运行时中不可用`)
  }
}

export const tty = {
  isatty: () => false,
  ReadStream: class ReadStream {},
  WriteStream: class WriteStream {}
}

export const childProcess = {
  exec: unavailable('child_process.exec'),
  execFile: unavailable('child_process.execFile'),
  execSync: unavailable('child_process.execSync'),
  execFileSync: unavailable('child_process.execFileSync'),
  fork: unavailable('child_process.fork'),
  spawn: unavailable('child_process.spawn'),
  spawnSync: unavailable('child_process.spawnSync')
}

export const electron = {
  app: undefined,
  BrowserWindow: undefined,
  session: undefined,
  net: undefined,
  shell: { openExternal: unavailable('electron.shell') }
}

export const dns = {
  lookup: (hostname, options, callback) => {
    const done = typeof options === 'function' ? options : callback
    done(Object.assign(new Error('dns.lookup is not available'), { code: 'ENOTSUP' }))
  },
  promises: { lookup: unavailable('dns.promises.lookup') },
  resolve: unavailable('dns.resolve'),
  setDefaultResultOrder() {}
}

export const perfHooks = {
  performance: globalThis.performance || { now: () => Date.now(), timeOrigin: Date.now(), mark() {}, measure() {} },
  PerformanceObserver: class PerformanceObserver {
    observe() {}
    disconnect() {}
  }
}

export const workerThreads = {
  isMainThread: true,
  parentPort: null,
  workerData: null,
  threadId: 0,
  Worker: class Worker {
    constructor() {
      throw new Error('worker_threads 在 Android 插件运行时中不可用')
    }
  }
}

export const tls = {
  connect: unavailable('tls.connect'),
  createSecureContext: () => ({}),
  rootCertificates: [],
  DEFAULT_MIN_VERSION: 'TLSv1.2',
  DEFAULT_MAX_VERSION: 'TLSv1.3'
}

export const readline = {
  createInterface: unavailable('readline.createInterface')
}

export const http2 = {
  connect: unavailable('http2.connect'),
  constants: {}
}

export const cluster = {
  isMaster: true,
  isPrimary: true,
  isWorker: false,
  fork: unavailable('cluster.fork'),
  on() {}
}

export const v8 = {
  getHeapStatistics: () => ({ total_heap_size: 0, used_heap_size: 0, heap_size_limit: 96 * 1024 * 1024 }),
  serialize: (value) => JSON.stringify(value),
  deserialize: (value) => JSON.parse(String(value))
}

export const module = {
  createRequire: () => (name) => {
    throw new Error(`Cannot find module '${name}'`)
  },
  builtinModules: []
}

export const diagnosticsChannel = {
  channel: () => ({ hasSubscribers: false, publish() {}, subscribe() {}, unsubscribe() {} }),
  hasSubscribers: () => false,
  subscribe() {},
  unsubscribe() {},
  tracingChannel: () => ({ hasSubscribers: false, traceSync: (fn, ctx, thisArg, ...args) => fn.apply(thisArg, args), tracePromise: (fn, ctx, thisArg, ...args) => fn.apply(thisArg, args) })
}
