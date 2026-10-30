import { TwilightPromise as Promise } from '../runtime/loop.js'

// node:events EventEmitter. A plain constructor function, as in Node, so
// npm code written as `EventEmitter.call(this)` + util.inherits works.
export function EventEmitter(options) {
  EventEmitter.init.call(this, options)
}

EventEmitter.init = function () {
  if (!this._events || this._events === Object.getPrototypeOf(this)._events) {
    this._events = Object.create(null)
    this._eventsCount = 0
  }
  this._maxListeners = this._maxListeners || undefined
}

const methods = {
  setMaxListeners(n) {
    this._maxListeners = n
    return this
  },
  getMaxListeners() {
    return this._maxListeners === undefined ? EventEmitter.defaultMaxListeners : this._maxListeners
  },
  _list(type) {
    if (!this._events) EventEmitter.init.call(this)
    return this._events[type]
  },
  emit(type, ...args) {
    const list = this._list(type)
    if (type === 'error' && (!list || !list.length)) {
      const error = args[0] instanceof Error ? args[0] : new Error('Unhandled error.' + (args[0] === undefined ? '' : ` (${args[0]})`))
      throw error
    }
    if (!list || !list.length) return false
    for (const entry of list.slice()) {
      if (entry.once) this.removeListener(type, entry.listener)
      entry.listener.apply(this, args)
    }
    return true
  },
  _add(type, listener, prepend, once) {
    if (typeof listener !== 'function') throw new TypeError('The "listener" argument must be of type function')
    if (!this._events) EventEmitter.init.call(this)
    if (this._events.newListener) this.emit('newListener', type, listener)
    const list = this._events[type] || (this._events[type] = [])
    if (!list.length) this._eventsCount++
    const entry = { listener, once }
    if (prepend) list.unshift(entry)
    else list.push(entry)
    return this
  },
  on(type, listener) {
    return this._add(type, listener, false, false)
  },
  addListener(type, listener) {
    return this.on(type, listener)
  },
  prependListener(type, listener) {
    return this._add(type, listener, true, false)
  },
  once(type, listener) {
    return this._add(type, listener, false, true)
  },
  prependOnceListener(type, listener) {
    return this._add(type, listener, true, true)
  },
  off(type, listener) {
    return this.removeListener(type, listener)
  },
  removeListener(type, listener) {
    const list = this._list(type)
    if (!list) return this
    const index = list.findIndex((entry) => entry.listener === listener)
    if (index >= 0) {
      list.splice(index, 1)
      if (!list.length) {
        delete this._events[type]
        this._eventsCount--
      }
      if (this._events.removeListener) this.emit('removeListener', type, listener)
    }
    return this
  },
  removeAllListeners(type) {
    if (!this._events) return this
    if (type === undefined) {
      this._events = Object.create(null)
      this._eventsCount = 0
    } else if (this._events[type]) {
      delete this._events[type]
      this._eventsCount--
    }
    return this
  },
  listeners(type) {
    return (this._list(type) || []).map((entry) => entry.listener)
  },
  rawListeners(type) {
    return this.listeners(type)
  },
  listenerCount(type) {
    return (this._list(type) || []).length
  },
  eventNames() {
    return this._events ? Object.keys(this._events) : []
  }
}

// Enumerable, as in Node: mixins copy EventEmitter.prototype with Object.assign.
Object.assign(EventEmitter.prototype, methods)

EventEmitter.defaultMaxListeners = 10
EventEmitter.EventEmitter = EventEmitter
EventEmitter.captureRejections = false
EventEmitter.errorMonitor = Symbol('events.errorMonitor')

export function once(emitter, name, options) {
  return new Promise((resolve, reject) => {
    const signal = options && options.signal
    const onEvent = (...args) => {
      cleanup()
      resolve(args)
    }
    const onError = (error) => {
      cleanup()
      reject(error)
    }
    const onAbort = () => {
      cleanup()
      reject(signal.reason)
    }
    const cleanup = () => {
      if (typeof emitter.removeListener === 'function') {
        emitter.removeListener(name, onEvent)
        if (name !== 'error') emitter.removeListener('error', onError)
      } else emitter.removeEventListener(name, onEvent)
      if (signal) signal.removeEventListener('abort', onAbort)
    }
    if (signal) {
      if (signal.aborted) {
        reject(signal.reason)
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }
    if (typeof emitter.once === 'function') {
      emitter.once(name, onEvent)
      if (name !== 'error') emitter.once('error', onError)
    } else emitter.addEventListener(name, onEvent, { once: true })
  })
}

export function listenerCount(emitter, type) {
  return emitter.listenerCount(type)
}

export function setMaxListeners() {}

export function getEventListeners(emitter, type) {
  return typeof emitter.listeners === 'function' ? emitter.listeners(type) : []
}

export const errorMonitor = EventEmitter.errorMonitor
export const captureRejectionSymbol = Symbol.for('nodejs.rejection')

EventEmitter.once = once
EventEmitter.listenerCount = listenerCount
EventEmitter.setMaxListeners = setMaxListeners
EventEmitter.getEventListeners = getEventListeners

export default EventEmitter
