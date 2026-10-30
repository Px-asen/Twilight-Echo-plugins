import { queueMicrotask, setTimeout } from './loop.js'

const DOM_CODES = {
  IndexSizeError: 1, NotFoundError: 8, NotSupportedError: 9, InvalidStateError: 11, SyntaxError: 12,
  InvalidAccessError: 15, TimeoutError: 23, DataCloneError: 25, AbortError: 20, NetworkError: 19
}

export class DOMException extends Error {
  constructor(message = '', name = 'Error') {
    super(message)
    this._name = String(name)
  }
  get name() {
    return this._name
  }
  get code() {
    return DOM_CODES[this._name] || 0
  }
}

export class Event {
  constructor(type, init = {}) {
    this.type = String(type)
    this.bubbles = Boolean(init.bubbles)
    this.cancelable = Boolean(init.cancelable)
    this.defaultPrevented = false
    this.target = null
    this.currentTarget = null
    this.timeStamp = Date.now()
  }
  preventDefault() {
    if (this.cancelable) this.defaultPrevented = true
  }
  stopPropagation() {}
  stopImmediatePropagation() {
    this._stopped = true
  }
}

export class EventTarget {
  constructor() {
    Object.defineProperty(this, '_listeners', { value: new Map(), enumerable: false })
  }
  addEventListener(type, listener, options) {
    if (!listener) return
    const list = this._listeners.get(type) || []
    if (list.some((entry) => entry.listener === listener)) return
    const once = typeof options === 'object' && options !== null && Boolean(options.once)
    const signal = typeof options === 'object' && options !== null ? options.signal : undefined
    if (signal && signal.aborted) return
    const entry = { listener, once }
    list.push(entry)
    this._listeners.set(type, list)
    if (signal) signal.addEventListener('abort', () => this.removeEventListener(type, listener), { once: true })
  }
  removeEventListener(type, listener) {
    const list = this._listeners.get(type)
    if (!list) return
    const next = list.filter((entry) => entry.listener !== listener)
    if (next.length) this._listeners.set(type, next)
    else this._listeners.delete(type)
  }
  dispatchEvent(event) {
    if (!event.target) event.target = this
    event.currentTarget = this
    const handler = this['on' + event.type]
    const list = (this._listeners.get(event.type) || []).slice()
    if (typeof handler === 'function') {
      try {
        handler.call(this, event)
      } catch (error) {
        queueMicrotask(() => { throw error })
      }
    }
    for (const entry of list) {
      if (entry.once) this.removeEventListener(event.type, entry.listener)
      try {
        if (typeof entry.listener === 'function') entry.listener.call(this, event)
        else entry.listener.handleEvent(event)
      } catch (error) {
        queueMicrotask(() => { throw error })
      }
      if (event._stopped) break
    }
    return !event.defaultPrevented
  }
}

export class AbortSignal extends EventTarget {
  constructor() {
    super()
    this.aborted = false
    this.reason = undefined
    this.onabort = null
  }
  throwIfAborted() {
    if (this.aborted) throw this.reason
  }
  _abort(reason) {
    if (this.aborted) return
    this.aborted = true
    this.reason = reason === undefined ? new DOMException('This operation was aborted', 'AbortError') : reason
    this.dispatchEvent(new Event('abort'))
  }
  static abort(reason) {
    const signal = new AbortSignal()
    signal._abort(reason)
    return signal
  }
  static timeout(ms) {
    const signal = new AbortSignal()
    setTimeout(() => signal._abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError')), ms)
    return signal
  }
  static any(signals) {
    const signal = new AbortSignal()
    for (const source of signals) {
      if (source.aborted) {
        signal._abort(source.reason)
        return signal
      }
    }
    for (const source of signals) {
      source.addEventListener('abort', () => signal._abort(source.reason), { once: true })
    }
    return signal
  }
}

export class AbortController {
  constructor() {
    this.signal = new AbortSignal()
  }
  abort(reason) {
    this.signal._abort(reason)
  }
}

export class CustomEvent extends Event {
  constructor(type, init = {}) {
    super(type, init)
    this.detail = init.detail === undefined ? null : init.detail
  }
}

export class MessageEvent extends Event {
  constructor(type, init = {}) {
    super(type, init)
    this.data = init.data
    this.origin = init.origin || ''
  }
}

export class CloseEvent extends Event {
  constructor(type, init = {}) {
    super(type, init)
    this.code = init.code || 1005
    this.reason = init.reason || ''
    this.wasClean = Boolean(init.wasClean)
  }
}
