import { TwilightPromise as Promise } from '../runtime/loop.js'
import { TextDecoder, TextEncoder } from '../runtime/encoding.js'

export { TextDecoder, TextEncoder }

const kCustomPromisify = Symbol.for('nodejs.util.promisify.custom')

export function promisify(fn) {
  if (typeof fn !== 'function') throw new TypeError('The "original" argument must be of type function')
  if (fn[kCustomPromisify]) return fn[kCustomPromisify]
  return function (...args) {
    return new Promise((resolve, reject) => {
      fn.call(this, ...args, (error, ...values) => {
        if (error) reject(error)
        else resolve(values.length > 1 ? values : values[0])
      })
    })
  }
}
promisify.custom = kCustomPromisify

export function callbackify(fn) {
  return function (...args) {
    const callback = args.pop()
    Promise.resolve(fn.apply(this, args)).then(
      (value) => callback(null, value),
      (error) => callback(error)
    )
  }
}

export function inherits(ctor, superCtor) {
  Object.defineProperty(ctor, 'super_', { value: superCtor, writable: true, configurable: true })
  Object.setPrototypeOf(ctor.prototype, superCtor.prototype)
}

export function deprecate(fn) {
  return fn
}

export function debuglog() {
  const log = () => {}
  log.enabled = false
  return log
}
export const debug = debuglog

function inspectValue(value, depth, seen) {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (typeof value === 'string') return depth === 0 ? value : `'${value}'`
  if (typeof value === 'bigint') return `${value}n`
  if (typeof value !== 'object' && typeof value !== 'function') return String(value)
  if (typeof value === 'function') return `[Function: ${value.name || '(anonymous)'}]`
  if (value instanceof Error) return value.stack || `${value.name}: ${value.message}`
  if (seen.has(value)) return '[Circular]'
  if (depth > 2) return Array.isArray(value) ? '[Array]' : '[Object]'
  seen.add(value)
  let out
  if (Array.isArray(value)) out = `[ ${value.map((item) => inspectValue(item, depth + 1, seen)).join(', ')} ]`
  else if (value instanceof Uint8Array) out = `<Buffer ${Array.from(value.subarray(0, 50), (b) => (b < 16 ? '0' : '') + b.toString(16)).join(' ')}${value.length > 50 ? ' ...' : ''}>`
  else if (value instanceof Map) out = `Map(${value.size}) { ${Array.from(value, ([k, v]) => `${inspectValue(k, depth + 1, seen)} => ${inspectValue(v, depth + 1, seen)}`).join(', ')} }`
  else if (value instanceof Set) out = `Set(${value.size}) { ${Array.from(value, (v) => inspectValue(v, depth + 1, seen)).join(', ')} }`
  else {
    const keys = Object.keys(value)
    out = keys.length ? `{ ${keys.map((key) => `${key}: ${inspectValue(value[key], depth + 1, seen)}`).join(', ')} }` : '{}'
  }
  seen.delete(value)
  return out
}

export function inspect(value) {
  return inspectValue(value, 1, new Set())
}
inspect.custom = Symbol.for('nodejs.util.inspect.custom')
inspect.defaultOptions = {}

export function format(template, ...args) {
  if (typeof template !== 'string') return [template, ...args].map((item) => inspectValue(item, 0, new Set())).join(' ')
  let index = 0
  let out = template.replace(/%[sdifjoO%]/g, (token) => {
    if (token === '%%') return '%'
    if (index >= args.length) return token
    const value = args[index++]
    switch (token) {
      case '%s':
        return typeof value === 'string' ? value : inspectValue(value, 0, new Set())
      case '%d':
      case '%i':
        return String(token === '%i' ? parseInt(value, 10) : Number(value))
      case '%f':
        return String(parseFloat(value))
      case '%j':
        try {
          return JSON.stringify(value)
        } catch {
          return '[Circular]'
        }
      default:
        return inspectValue(value, 1, new Set())
    }
  })
  for (; index < args.length; index++) out += ' ' + inspectValue(args[index], 0, new Set())
  return out
}

export function formatWithOptions(options, ...args) {
  return format(...args)
}

function deepEqual(a, b, seen) {
  if (Object.is(a, b)) return true
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false
  if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false
  if (seen.has(a)) return seen.get(a) === b
  seen.set(a, b)
  if (a instanceof Date) return a.getTime() === b.getTime()
  if (ArrayBuffer.isView(a)) {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
    return true
  }
  if (a instanceof Map || a instanceof Set) {
    if (a.size !== b.size) return false
    if (a instanceof Set) return Array.from(a).every((item) => b.has(item))
    return Array.from(a).every(([key, value]) => b.has(key) && deepEqual(value, b.get(key), seen))
  }
  const keysA = Object.keys(a)
  const keysB = Object.keys(b)
  if (keysA.length !== keysB.length) return false
  return keysA.every((key) => Object.prototype.hasOwnProperty.call(b, key) && deepEqual(a[key], b[key], seen))
}

export function isDeepStrictEqual(a, b) {
  return deepEqual(a, b, new Map())
}

const tag = (value) => Object.prototype.toString.call(value).slice(8, -1)

export const types = {
  isUint8Array: (value) => value instanceof Uint8Array,
  isArrayBuffer: (value) => value instanceof ArrayBuffer,
  isAnyArrayBuffer: (value) => value instanceof ArrayBuffer,
  isArrayBufferView: (value) => ArrayBuffer.isView(value),
  isTypedArray: (value) => ArrayBuffer.isView(value) && !(value instanceof DataView),
  isDataView: (value) => value instanceof DataView,
  isDate: (value) => value instanceof Date,
  isRegExp: (value) => value instanceof RegExp,
  isMap: (value) => value instanceof Map,
  isSet: (value) => value instanceof Set,
  isPromise: (value) => Boolean(value) && typeof value.then === 'function',
  isNativeError: (value) => value instanceof Error,
  isAsyncFunction: (value) => tag(value) === 'AsyncFunction',
  isGeneratorFunction: (value) => tag(value) === 'GeneratorFunction',
  isBoxedPrimitive: () => false,
  isProxy: () => false
}

export const isArray = Array.isArray
export const isBuffer = (value) => value instanceof Uint8Array && value.constructor && value.constructor.name === 'Buffer'
export const isString = (value) => typeof value === 'string'
export const isNumber = (value) => typeof value === 'number'
export const isFunction = (value) => typeof value === 'function'
export const isObject = (value) => value !== null && typeof value === 'object'
export const isError = (value) => value instanceof Error
export const isDate = (value) => value instanceof Date
export const isRegExp = (value) => value instanceof RegExp
export const isPrimitive = (value) => value === null || (typeof value !== 'object' && typeof value !== 'function')
export const isNullOrUndefined = (value) => value === null || value === undefined

export function stripVTControlCharacters(text) {
  return String(text).replace(/\u001b\[[0-9;]*m/g, '')
}

export function toUSVString(text) {
  return String(text).replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '�')
}

export default {
  promisify,
  callbackify,
  inherits,
  deprecate,
  debuglog,
  debug,
  inspect,
  format,
  formatWithOptions,
  isDeepStrictEqual,
  types,
  isArray,
  isBuffer,
  isString,
  isNumber,
  isFunction,
  isObject,
  isError,
  isDate,
  isRegExp,
  isPrimitive,
  isNullOrUndefined,
  stripVTControlCharacters,
  toUSVString,
  TextEncoder,
  TextDecoder
}
