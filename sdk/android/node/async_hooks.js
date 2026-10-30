// node:async_hooks — AsyncLocalStorage without propagation across awaits.
// Values set with run() are visible synchronously inside the callback.
export class AsyncLocalStorage {
  constructor() {
    this._store = undefined
    this._enabled = false
  }
  getStore() {
    return this._enabled ? this._store : undefined
  }
  run(store, callback, ...args) {
    const previous = this._store
    const wasEnabled = this._enabled
    this._store = store
    this._enabled = true
    try {
      return callback(...args)
    } finally {
      this._store = previous
      this._enabled = wasEnabled
    }
  }
  exit(callback, ...args) {
    const previous = this._store
    this._store = undefined
    try {
      return callback(...args)
    } finally {
      this._store = previous
    }
  }
  enterWith(store) {
    this._store = store
    this._enabled = true
  }
  disable() {
    this._enabled = false
    this._store = undefined
  }
  static bind(fn) {
    return fn
  }
  static snapshot() {
    return (fn, ...args) => fn(...args)
  }
}

export class AsyncResource {
  constructor(type) {
    this.type = type
  }
  runInAsyncScope(fn, thisArg, ...args) {
    return fn.apply(thisArg, args)
  }
  bind(fn) {
    return fn.bind(this)
  }
  emitDestroy() {
    return this
  }
  asyncId() {
    return 1
  }
  triggerAsyncId() {
    return 0
  }
  static bind(fn) {
    return fn
  }
}

export function createHook() {
  return { enable() { return this }, disable() { return this } }
}

export function executionAsyncId() {
  return 1
}

export function triggerAsyncId() {
  return 0
}

export function executionAsyncResource() {
  return {}
}

export default { AsyncLocalStorage, AsyncResource, createHook, executionAsyncId, triggerAsyncId, executionAsyncResource }
