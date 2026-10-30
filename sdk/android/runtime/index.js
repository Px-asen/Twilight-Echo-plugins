import { hostCall } from './host.js'
import {
  TwilightPromise,
  clearImmediate,
  clearInterval,
  clearTimeout,
  queueMicrotask,
  setImmediate,
  setInterval,
  setTimeout
} from './loop.js'
import { TextDecoder, TextEncoder, atob, btoa } from './encoding.js'
import { Buffer } from './buffer.js'
import { URL, URLSearchParams } from './url.js'
import {
  AbortController,
  AbortSignal,
  CloseEvent,
  CustomEvent,
  DOMException,
  Event,
  EventTarget,
  MessageEvent
} from './events.js'
import { Blob, File, FormData, Headers, ReadableStream, Request, Response, fetch } from './fetch.js'
import { WebSocket } from './websocket.js'
import { webcrypto } from './webcrypto.js'
import process from '../node/process.js'

// Installs the web/Node globals desktop plugins expect into the bare QuickJS
// context. Imported first by every Android bundle (see build.mjs), so plugin
// modules can use these globals at top level.

function define(target, name, value) {
  if (!target || Object.prototype.hasOwnProperty.call(target, name)) return
  Object.defineProperty(target, name, { value, writable: true, configurable: true, enumerable: false })
}

// ── ES2021+ built-ins missing from QuickJS 2020 ───────────────────────────
function relativeIndex(length, index) {
  const value = Math.trunc(Number(index)) || 0
  return value < 0 ? value + length : value
}

function at(index) {
  const length = this.length >>> 0
  const i = relativeIndex(length, index)
  return i < 0 || i >= length ? undefined : this[i]
}

function findLast(predicate, thisArg) {
  for (let i = (this.length >>> 0) - 1; i >= 0; i--) if (predicate.call(thisArg, this[i], i, this)) return this[i]
  return undefined
}

function findLastIndex(predicate, thisArg) {
  for (let i = (this.length >>> 0) - 1; i >= 0; i--) if (predicate.call(thisArg, this[i], i, this)) return i
  return -1
}

function copyOf(value) {
  return Array.isArray(value) ? Array.prototype.slice.call(value) : Array.from(value)
}

const TypedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype)

define(Array.prototype, 'at', at)
define(String.prototype, 'at', at)
define(TypedArrayPrototype, 'at', at)
define(Array.prototype, 'findLast', findLast)
define(Array.prototype, 'findLastIndex', findLastIndex)
define(TypedArrayPrototype, 'findLast', findLast)
define(TypedArrayPrototype, 'findLastIndex', findLastIndex)
define(Array.prototype, 'toSorted', function toSorted(compare) {
  return copyOf(this).sort(compare)
})
define(Array.prototype, 'toReversed', function toReversed() {
  return copyOf(this).reverse()
})
define(Array.prototype, 'toSpliced', function toSpliced(...args) {
  const copy = copyOf(this)
  copy.splice(...args)
  return copy
})
define(Array.prototype, 'with', function withValue(index, value) {
  const copy = copyOf(this)
  const i = relativeIndex(copy.length, index)
  if (i < 0 || i >= copy.length) throw new RangeError('Invalid index')
  copy[i] = value
  return copy
})
define(TypedArrayPrototype, 'toSorted', function toSorted(compare) {
  return new this.constructor(this).sort(compare)
})
define(TypedArrayPrototype, 'toReversed', function toReversed() {
  return new this.constructor(this).reverse()
})

define(String.prototype, 'replaceAll', function replaceAll(search, replacement) {
  if (search instanceof RegExp) {
    if (!search.global) throw new TypeError('replaceAll must be called with a global RegExp')
    return String(this).replace(search, replacement)
  }
  const pattern = new RegExp(String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')
  return String(this).replace(pattern, replacement)
})

define(Object, 'hasOwn', function hasOwn(object, key) {
  if (object === null || object === undefined) throw new TypeError('Cannot convert undefined or null to object')
  return Object.prototype.hasOwnProperty.call(object, key)
})

define(Object, 'groupBy', function groupBy(items, callback) {
  const groups = Object.create(null)
  let index = 0
  for (const item of items) {
    const key = callback(item, index++)
    if (groups[key]) groups[key].push(item)
    else groups[key] = [item]
  }
  return groups
})

define(Map, 'groupBy', function groupBy(items, callback) {
  const groups = new Map()
  let index = 0
  for (const item of items) {
    const key = callback(item, index++)
    if (groups.has(key)) groups.get(key).push(item)
    else groups.set(key, [item])
  }
  return groups
})

if (typeof globalThis.AggregateError !== 'function') {
  class AggregateError extends Error {
    constructor(errors, message) {
      super(message)
      this.errors = Array.from(errors || [])
    }
  }
  define(AggregateError.prototype, 'name', 'AggregateError')
  define(globalThis, 'AggregateError', AggregateError)
}

if (typeof globalThis.WeakRef !== 'function') {
  // Strong reference: QuickJS has no weak references; plugin caches stay small.
  class WeakRef {
    constructor(target) {
      this._target = target
    }
    deref() {
      return this._target
    }
  }
  define(globalThis, 'WeakRef', WeakRef)
}

if (typeof globalThis.FinalizationRegistry !== 'function') {
  class FinalizationRegistry {
    register() {}
    unregister() {
      return false
    }
  }
  define(globalThis, 'FinalizationRegistry', FinalizationRegistry)
}

define(Error, 'captureStackTrace', function captureStackTrace(target) {
  if (!target || typeof target !== 'object') return
  try {
    if (!('stack' in target)) target.stack = new Error(target.message).stack
  } catch {
    // frozen errors keep their own stack
  }
})
if (Error.stackTraceLimit === undefined) Error.stackTraceLimit = 10

// ── structuredClone ───────────────────────────────────────────────────────
function cloneValue(value, seen) {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'function' || typeof value === 'symbol') {
      throw new DOMException(`${String(value)} could not be cloned.`, 'DataCloneError')
    }
    return value
  }
  if (seen.has(value)) return seen.get(value)
  let out
  if (value instanceof Date) out = new Date(value.getTime())
  else if (value instanceof RegExp) out = new RegExp(value.source, value.flags)
  else if (value instanceof ArrayBuffer) out = value.slice(0)
  else if (value instanceof DataView) {
    out = new DataView(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength))
  } else if (ArrayBuffer.isView(value)) {
    const Ctor = globalThis[value[Symbol.toStringTag]] || Uint8Array
    out = new Ctor(value)
  } else if (value instanceof Map) {
    out = new Map()
    seen.set(value, out)
    for (const [key, item] of value) out.set(cloneValue(key, seen), cloneValue(item, seen))
    return out
  } else if (value instanceof Set) {
    out = new Set()
    seen.set(value, out)
    for (const item of value) out.add(cloneValue(item, seen))
    return out
  } else if (value instanceof Error) {
    out = new Error(value.message)
    out.name = value.name
    if (value.stack) out.stack = value.stack
  } else if (Array.isArray(value)) {
    out = new Array(value.length)
    seen.set(value, out)
    for (let i = 0; i < value.length; i++) out[i] = cloneValue(value[i], seen)
    return out
  } else {
    out = {}
    seen.set(value, out)
    for (const key of Object.keys(value)) out[key] = cloneValue(value[key], seen)
    return out
  }
  seen.set(value, out)
  return out
}

function structuredClone(value) {
  return cloneValue(value, new Map())
}

// ── console → host log ────────────────────────────────────────────────────
const LOG_LIMIT_PER_CALL = 200
const LOG_MESSAGE_LIMIT = 4000
let logBudget = LOG_LIMIT_PER_CALL

/** Called at the start of every host request so one chatty call cannot flood logcat. */
export function resetLogBudget() {
  logBudget = LOG_LIMIT_PER_CALL
}

function describe(value) {
  if (typeof value === 'string') return value
  if (value instanceof Error) return value.stack ? `${value.name}: ${value.message}\n${value.stack}` : `${value.name}: ${value.message}`
  if (value === undefined) return 'undefined'
  if (typeof value === 'function') return `[Function ${value.name || 'anonymous'}]`
  if (typeof value === 'bigint' || typeof value === 'symbol') return String(value)
  try {
    const text = JSON.stringify(value)
    return text === undefined ? String(value) : text
  } catch {
    return String(value)
  }
}

export function hostLog(level, args) {
  if (logBudget <= 0) return
  logBudget--
  let message = Array.prototype.map.call(args, describe).join(' ')
  if (message.length > LOG_MESSAGE_LIMIT) message = `${message.slice(0, LOG_MESSAGE_LIMIT)}…`
  try {
    hostCall('log', { level, message })
  } catch {
    // logging never fails a plugin call
  }
}

const timers = new Map()
const counters = new Map()
const consoleObject = {
  debug: (...args) => hostLog('debug', args),
  log: (...args) => hostLog('info', args),
  info: (...args) => hostLog('info', args),
  warn: (...args) => hostLog('warn', args),
  error: (...args) => hostLog('error', args),
  trace: (...args) => hostLog('debug', args),
  dir: (value) => hostLog('debug', [value]),
  table: (value) => hostLog('debug', [value]),
  assert: (condition, ...args) => {
    if (!condition) hostLog('error', ['Assertion failed', ...args])
  },
  time: (label = 'default') => timers.set(label, Date.now()),
  timeEnd: (label = 'default') => {
    const started = timers.get(label)
    timers.delete(label)
    if (started !== undefined) hostLog('debug', [`${label}: ${Date.now() - started}ms`])
  },
  timeLog: (label = 'default', ...args) => {
    const started = timers.get(label)
    if (started !== undefined) hostLog('debug', [`${label}: ${Date.now() - started}ms`, ...args])
  },
  count: (label = 'default') => {
    const next = (counters.get(label) || 0) + 1
    counters.set(label, next)
    hostLog('debug', [`${label}: ${next}`])
  },
  countReset: (label = 'default') => counters.delete(label),
  group() {},
  groupCollapsed() {},
  groupEnd() {}
}

// ── performance ───────────────────────────────────────────────────────────
const timeOrigin = Date.now()
const performanceObject = {
  timeOrigin,
  now: () => Date.now() - timeOrigin,
  mark() {},
  measure() {},
  clearMarks() {},
  clearMeasures() {},
  getEntries: () => [],
  getEntriesByName: () => [],
  getEntriesByType: () => [],
  toJSON: () => ({ timeOrigin })
}

// ── Install ───────────────────────────────────────────────────────────────
Object.defineProperty(process, Symbol.toStringTag, { value: 'process', configurable: true })

const globals = {
  // Async functions are lowered onto this Promise at build time, so it must
  // replace the native one: the worker drives its job queue (see loop.js).
  Promise: TwilightPromise,
  queueMicrotask,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  setImmediate,
  clearImmediate,
  structuredClone,
  TextEncoder,
  TextDecoder,
  atob,
  btoa,
  Buffer,
  URL,
  URLSearchParams,
  DOMException,
  Event,
  EventTarget,
  CustomEvent,
  MessageEvent,
  CloseEvent,
  AbortController,
  AbortSignal,
  Blob,
  File,
  FormData,
  Headers,
  Request,
  Response,
  ReadableStream,
  fetch,
  WebSocket,
  crypto: webcrypto,
  process,
  console: consoleObject,
  performance: performanceObject
}

for (const name of Object.keys(globals)) {
  Object.defineProperty(globalThis, name, { value: globals[name], writable: true, configurable: true, enumerable: false })
}
if (typeof globalThis.global === 'undefined') define(globalThis, 'global', globalThis)
if (typeof globalThis.self === 'undefined') define(globalThis, 'self', globalThis)
