import { hostCall } from './host.js'

// One QuickJS context per plugin runs this loop. Host IO is synchronous, so the
// only things a pending call can wait for are timers and host IO sources
// (WebSocket queues). The worker drives the loop until the call settles.

const microtasks = []
let microtaskHead = 0
const macrotasks = []
const timers = new Map()
const ioSources = new Set()
let timerSeq = 0
let currentDeadline = 0

export function queueMicrotask(callback) {
  if (typeof callback !== 'function') throw new TypeError('queueMicrotask requires a function')
  microtasks.push(callback)
}

export function queueMacrotask(callback) {
  macrotasks.push(callback)
}

export function reportError(error) {
  // There is no unhandled-error channel on Android; keep the loop alive.
  try {
    const handler = globalThis.__TWILIGHT_ON_ERROR__
    if (typeof handler === 'function') handler(error)
  } catch {
    // ignore
  }
}

function runMicrotasks() {
  while (microtaskHead < microtasks.length) {
    const task = microtasks[microtaskHead]
    microtasks[microtaskHead++] = undefined
    try {
      task()
    } catch (error) {
      reportError(error)
    }
    if (microtaskHead >= 1024 && microtaskHead * 2 >= microtasks.length) {
      microtasks.splice(0, microtaskHead)
      microtaskHead = 0
    }
  }
  microtasks.length = 0
  microtaskHead = 0
}

// ── Promise ────────────────────────────────────────────────────────────────
const PENDING = 0
const FULFILLED = 1
const REJECTED = 2

function settle(promise, state, value) {
  if (promise._state !== PENDING) return
  promise._state = state
  promise._value = value
  const reactions = promise._reactions
  promise._reactions = null
  for (let i = 0; i < reactions.length; i++) scheduleReaction(promise, reactions[i])
}

function resolvePromise(promise, value) {
  if (value === promise) {
    settle(promise, REJECTED, new TypeError('Chaining cycle detected for promise'))
    return
  }
  if (value !== null && (typeof value === 'object' || typeof value === 'function')) {
    let then
    try {
      then = value.then
    } catch (error) {
      settle(promise, REJECTED, error)
      return
    }
    if (typeof then === 'function') {
      queueMicrotask(() => {
        let called = false
        try {
          then.call(
            value,
            (next) => {
              if (called) return
              called = true
              resolvePromise(promise, next)
            },
            (error) => {
              if (called) return
              called = true
              settle(promise, REJECTED, error)
            }
          )
        } catch (error) {
          if (!called) {
            called = true
            settle(promise, REJECTED, error)
          }
        }
      })
      return
    }
  }
  settle(promise, FULFILLED, value)
}

function scheduleReaction(promise, reaction) {
  queueMicrotask(() => {
    const fulfilled = promise._state === FULFILLED
    const handler = fulfilled ? reaction.onFulfilled : reaction.onRejected
    if (typeof handler !== 'function') {
      if (fulfilled) reaction.resolve(promise._value)
      else reaction.reject(promise._value)
      return
    }
    let result
    try {
      result = handler(promise._value)
    } catch (error) {
      reaction.reject(error)
      return
    }
    reaction.resolve(result)
  })
}

export class TwilightPromise {
  constructor(executor) {
    if (typeof executor !== 'function') throw new TypeError('Promise resolver is not a function')
    this._state = PENDING
    this._value = undefined
    this._reactions = []
    let called = false
    const resolve = (value) => {
      if (called) return
      called = true
      resolvePromise(this, value)
    }
    const reject = (error) => {
      if (called) return
      called = true
      settle(this, REJECTED, error)
    }
    try {
      executor(resolve, reject)
    } catch (error) {
      reject(error)
    }
  }

  then(onFulfilled, onRejected) {
    let reaction
    const next = new TwilightPromise((resolve, reject) => {
      reaction = { onFulfilled, onRejected, resolve, reject }
    })
    if (this._state === PENDING) this._reactions.push(reaction)
    else scheduleReaction(this, reaction)
    return next
  }

  catch(onRejected) {
    return this.then(undefined, onRejected)
  }

  finally(callback) {
    if (typeof callback !== 'function') return this.then(callback, callback)
    return this.then(
      (value) => TwilightPromise.resolve(callback()).then(() => value),
      (error) =>
        TwilightPromise.resolve(callback()).then(() => {
          throw error
        })
    )
  }

  static resolve(value) {
    if (value instanceof TwilightPromise && value.constructor === TwilightPromise) return value
    return new TwilightPromise((resolve) => resolve(value))
  }

  static reject(error) {
    return new TwilightPromise((_, reject) => reject(error))
  }

  static withResolvers() {
    let resolve
    let reject
    const promise = new TwilightPromise((res, rej) => {
      resolve = res
      reject = rej
    })
    return { promise, resolve, reject }
  }

  static all(values) {
    return new TwilightPromise((resolve, reject) => {
      const items = Array.from(values)
      const results = new Array(items.length)
      let remaining = items.length
      if (!remaining) resolve(results)
      items.forEach((item, index) => {
        TwilightPromise.resolve(item).then((value) => {
          results[index] = value
          if (--remaining === 0) resolve(results)
        }, reject)
      })
    })
  }

  static allSettled(values) {
    return TwilightPromise.all(
      Array.from(values).map((item) =>
        TwilightPromise.resolve(item).then(
          (value) => ({ status: 'fulfilled', value }),
          (reason) => ({ status: 'rejected', reason })
        )
      )
    )
  }

  static race(values) {
    return new TwilightPromise((resolve, reject) => {
      for (const item of values) TwilightPromise.resolve(item).then(resolve, reject)
    })
  }

  static any(values) {
    return new TwilightPromise((resolve, reject) => {
      const items = Array.from(values)
      const errors = new Array(items.length)
      let remaining = items.length
      const fail = () => {
        const Aggregate = globalThis.AggregateError
        const error = typeof Aggregate === 'function'
          ? new Aggregate(errors, 'All promises were rejected')
          : Object.assign(new Error('All promises were rejected'), { errors })
        reject(error)
      }
      if (!remaining) fail()
      items.forEach((item, index) => {
        TwilightPromise.resolve(item).then(resolve, (error) => {
          errors[index] = error
          if (--remaining === 0) fail()
        })
      })
    })
  }
}

Object.defineProperty(TwilightPromise.prototype, Symbol.toStringTag, { value: 'Promise' })

// ── Timers ─────────────────────────────────────────────────────────────────
class Timeout {
  constructor(callback, delay, args, repeat) {
    this._id = ++timerSeq
    this._callback = callback
    this._args = args
    this._delay = Math.max(1, Math.floor(Number(delay) || 0))
    this._repeat = repeat
    this._due = Date.now() + this._delay
    this._ref = true
  }
  ref() { this._ref = true; return this }
  unref() { this._ref = false; return this }
  hasRef() { return this._ref }
  refresh() { this._due = Date.now() + this._delay; return this }
  close() { clearTimer(this); return this }
  [Symbol.toPrimitive]() { return this._id }
}

function clearTimer(handle) {
  if (handle === undefined || handle === null) return
  const id = typeof handle === 'object' ? handle._id : Number(handle)
  timers.delete(id)
}

export function setTimeout(callback, delay, ...args) {
  if (typeof callback !== 'function') throw new TypeError('setTimeout requires a function')
  const timer = new Timeout(callback, delay, args, false)
  timers.set(timer._id, timer)
  return timer
}

export function setInterval(callback, delay, ...args) {
  if (typeof callback !== 'function') throw new TypeError('setInterval requires a function')
  const timer = new Timeout(callback, delay, args, true)
  timers.set(timer._id, timer)
  return timer
}

export function setImmediate(callback, ...args) {
  const immediate = { _cancelled: false, ref() { return this }, unref() { return this }, hasRef() { return true } }
  queueMacrotask(() => {
    if (!immediate._cancelled) callback(...args)
  })
  return immediate
}

export function clearImmediate(immediate) {
  if (immediate && typeof immediate === 'object') immediate._cancelled = true
}

export const clearTimeout = clearTimer
export const clearInterval = clearTimer

function earliestTimer() {
  let next = null
  for (const timer of timers.values()) if (!next || timer._due < next._due) next = timer
  return next
}

function runTimer(timer) {
  if (timer._repeat) timer._due = Date.now() + timer._delay
  else timers.delete(timer._id)
  try {
    timer._callback(...timer._args)
  } catch (error) {
    reportError(error)
  }
}

// ── IO sources (host-backed queues such as WebSocket) ─────────────────────
export function registerIoSource(source) {
  ioSources.add(source)
  return () => ioSources.delete(source)
}

function pollIo(waitMs) {
  if (!ioSources.size) return false
  const sources = Array.from(ioSources)
  const ids = sources.map((source) => source.ioId)
  const events = hostCall('ws.poll', { ids, timeoutMs: Math.max(0, Math.min(2000, Math.floor(waitMs))) })
  if (!Array.isArray(events) || !events.length) return false
  for (const event of events) {
    const source = sources.find((item) => item.ioId === event.id)
    if (!source) continue
    try {
      source.deliver(event)
    } catch (error) {
      reportError(error)
    }
  }
  return true
}

function sleep(ms) {
  hostCall('sleep', { ms: Math.max(0, Math.min(2000, Math.floor(ms))) })
}

/** Run everything that is runnable now; never waits. Returns true when work ran. */
function step() {
  runMicrotasks()
  if (macrotasks.length) {
    const task = macrotasks.shift()
    try {
      task()
    } catch (error) {
      reportError(error)
    }
    return true
  }
  const timer = earliestTimer()
  if (timer && timer._due <= Date.now()) {
    runTimer(timer)
    return true
  }
  return pollIo(0)
}

/** Deliver what happened while no call was running (due timers, socket frames). */
export function pump(budgetMs = 2000) {
  const until = Date.now() + budgetMs
  while (step() && Date.now() < until) {
    // keep stepping
  }
  runMicrotasks()
}

export function currentCallDeadline() {
  return currentDeadline
}

/** Drive the loop until `isDone()` or the call deadline. */
export function run(isDone, timeoutMs = 45000) {
  currentDeadline = Date.now() + timeoutMs
  try {
    for (;;) {
      runMicrotasks()
      if (isDone()) break
      if (Date.now() >= currentDeadline) throw new Error('插件调用超时')
      if (step()) continue
      runMicrotasks()
      if (isDone()) break
      const now = Date.now()
      const timer = earliestTimer()
      if (!timer && !ioSources.size) throw new Error('插件调用未完成：没有可等待的任务')
      const wait = Math.max(0, Math.min(timer ? timer._due - now : 1000, currentDeadline - now, 1000))
      if (ioSources.size) pollIo(wait)
      else if (wait > 0) sleep(wait)
    }
    // Finish fire-and-forget work (settings writes, cache updates) that is already runnable.
    pump(250)
  } finally {
    currentDeadline = 0
  }
}
