import { EventEmitter } from './events.js'
import { Buffer } from '../runtime/buffer.js'
import { TwilightPromise as Promise, queueMicrotask } from '../runtime/loop.js'
import { ReadableStream } from '../runtime/fetch.js'

// node:stream subset: enough for provider proxies (Readable.fromWeb +
// pipeline into a ServerResponse) and simple Transform/PassThrough users.
// Backpressure is advisory: write() always accepts the chunk.

function toChunk(chunk, encoding, objectMode) {
  if (objectMode) return chunk
  if (typeof chunk === 'string') return Buffer.from(chunk, encoding || 'utf8')
  if (chunk instanceof Buffer) return chunk
  if (chunk instanceof ArrayBuffer || ArrayBuffer.isView(chunk)) return Buffer.from(chunk instanceof ArrayBuffer ? new Uint8Array(chunk) : new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength))
  throw new TypeError('The "chunk" argument must be of type string or an instance of Buffer or Uint8Array.')
}

// Constructor functions rather than classes, as in Node, so npm code written
// as `Readable.call(this, options)` + util.inherits works.
function inherit(ctor, superCtor) {
  Object.setPrototypeOf(ctor.prototype, superCtor.prototype)
  Object.setPrototypeOf(ctor, superCtor)
}

function define(target, members) {
  for (const key of Reflect.ownKeys(members)) Object.defineProperty(target, key, Object.getOwnPropertyDescriptor(members, key))
}

export function Stream(options) {
  EventEmitter.call(this, options)
}
inherit(Stream, EventEmitter)

Stream.prototype.pipe = function (destination, options) {
  return Readable.prototype.pipe.call(this, destination, options)
}

export function Readable(options) {
  if (!(this instanceof Readable)) return new Readable(options)
  options = options || {}
  Stream.call(this, options)
  this._readableState = {
    buffer: [],
    ended: false,
    endEmitted: false,
    flowing: null,
    reading: false,
    scheduled: false,
    encoding: options.encoding || null,
    objectMode: Boolean(options.objectMode || options.readableObjectMode),
    highWaterMark: options.highWaterMark === undefined ? 16384 : options.highWaterMark
  }
  this.destroyed = false
  this.readable = true
  if (typeof options.read === 'function') this._read = options.read
  if (typeof options.destroy === 'function') this._destroy = options.destroy
  if (options.signal) {
    const signal = options.signal
    if (signal.aborted) this.destroy(signal.reason)
    else signal.addEventListener('abort', () => this.destroy(signal.reason), { once: true })
  }
}
inherit(Readable, Stream)

define(Readable.prototype, {
  get readableEnded() {
    return this._readableState.endEmitted
  },
  get readableFlowing() {
    return this._readableState.flowing
  },
  get readableLength() {
    return this._readableState.buffer.length
  },
  get readableObjectMode() {
    return this._readableState.objectMode
  },
  _read() {},
  push(chunk, encoding) {
    const state = this._readableState
    if (this.destroyed || state.ended) return false
    state.reading = false
    if (chunk === null) {
      state.ended = true
    } else {
      const value = toChunk(chunk, encoding, state.objectMode)
      if (state.objectMode || value.length) state.buffer.push(value)
      this.emit('readable')
    }
    this._schedule()
    return state.buffer.length < Math.max(1, state.highWaterMark / 16384)
  },
  unshift(chunk) {
    this._readableState.buffer.unshift(toChunk(chunk, undefined, this._readableState.objectMode))
    this._schedule()
  },
  read() {
    const state = this._readableState
    if (!state.buffer.length) {
      this._pull()
      return null
    }
    const chunk = state.buffer.shift()
    this._schedule()
    return this._decode(chunk)
  },
  setEncoding(encoding) {
    this._readableState.encoding = encoding
    return this
  },
  _decode(chunk) {
    const encoding = this._readableState.encoding
    return encoding && chunk instanceof Uint8Array ? Buffer.from(chunk).toString(encoding) : chunk
  },
  _schedule() {
    const state = this._readableState
    if (state.scheduled) return
    state.scheduled = true
    queueMicrotask(() => {
      state.scheduled = false
      this._flow()
    })
  },
  _pull() {
    const state = this._readableState
    if (state.reading || state.ended || this.destroyed) return
    state.reading = true
    try {
      this._read(state.highWaterMark)
    } catch (error) {
      this.destroy(error)
    }
  },
  _flow() {
    const state = this._readableState
    if (this.destroyed) return
    while (state.flowing && state.buffer.length && !this.destroyed) {
      this.emit('data', this._decode(state.buffer.shift()))
    }
    if (!state.buffer.length && state.ended) {
      if (!state.endEmitted && state.flowing !== false) {
        state.endEmitted = true
        this.readable = false
        this.emit('end')
        if (!this.destroyed) {
          this.destroyed = true
          this.emit('close')
        }
      }
      return
    }
    if (state.flowing && !state.buffer.length) this._pull()
  },
  on(type, listener) {
    Stream.prototype.on.call(this, type, listener)
    if (type === 'data' && this._readableState.flowing !== false) this.resume()
    if (type === 'readable') this._pull()
    return this
  },
  resume() {
    this._readableState.flowing = true
    this._schedule()
    return this
  },
  pause() {
    this._readableState.flowing = false
    return this
  },
  isPaused() {
    return this._readableState.flowing === false
  },
  destroy(error) {
    if (this.destroyed) return this
    this.destroyed = true
    this.readable = false
    const finish = (err) => {
      queueMicrotask(() => {
        if (err) this.emit('error', err)
        this.emit('close')
      })
    }
    if (this._destroy) {
      try {
        this._destroy(error || null, finish)
      } catch (err) {
        finish(err)
      }
    } else finish(error)
    return this
  },
  pipe(destination, options = {}) {
    const onData = (chunk) => {
      if (destination.write(chunk) === false && typeof this.pause === 'function') {
        this.pause()
        destination.once('drain', () => this.resume())
      }
    }
    this.on('data', onData)
    if (options.end !== false) this.once('end', () => destination.end())
    destination.emit('pipe', this)
    return destination
  },
  unpipe() {
    this.removeAllListeners('data')
    return this
  },
  [Symbol.asyncIterator]() {
    const stream = this
    const queue = []
    const waiters = []
    let ended = false
    let failure = null
    const settle = () => {
      while (waiters.length && (queue.length || ended || failure)) {
        const waiter = waiters.shift()
        if (queue.length) waiter.resolve({ value: queue.shift(), done: false })
        else if (failure) waiter.reject(failure)
        else waiter.resolve({ value: undefined, done: true })
      }
    }
    stream.on('data', (chunk) => {
      queue.push(chunk)
      settle()
    })
    stream.once('end', () => {
      ended = true
      settle()
    })
    stream.once('error', (error) => {
      failure = error
      settle()
    })
    stream.once('close', () => {
      ended = true
      settle()
    })
    return {
      next() {
        return new Promise((resolve, reject) => {
          waiters.push({ resolve, reject })
          settle()
        })
      },
      return(value) {
        stream.destroy()
        return Promise.resolve({ value, done: true })
      },
      [Symbol.asyncIterator]() {
        return this
      }
    }
  }
})
Readable.prototype.addListener = Readable.prototype.on

Readable.from = function (iterable, options = {}) {
  if (typeof iterable === 'string' || iterable instanceof Uint8Array) {
    return new Readable({
      objectMode: true,
      ...options,
      read() {
        this.push(iterable)
        this.push(null)
      }
    })
  }
  const iterator = iterable[Symbol.asyncIterator] ? iterable[Symbol.asyncIterator]() : iterable[Symbol.iterator]()
  return new Readable({
    objectMode: true,
    ...options,
    read() {
      Promise.resolve(iterator.next()).then(
        (step) => {
          if (step.done) this.push(null)
          else this.push(step.value)
        },
        (error) => this.destroy(error)
      )
    },
    destroy(error, callback) {
      if (typeof iterator.return === 'function') Promise.resolve(iterator.return()).then(() => callback(error), () => callback(error))
      else callback(error)
    }
  })
}

Readable.fromWeb = function (webStream, options = {}) {
  const reader = webStream.getReader()
  return new Readable({
    ...options,
    read() {
      reader.read().then(
        ({ value, done }) => {
          if (done) this.push(null)
          else this.push(typeof value === 'string' ? value : Buffer.from(value))
        },
        (error) => this.destroy(error)
      )
    },
    destroy(error, callback) {
      reader.cancel(error).then(() => callback(error), () => callback(error))
    }
  })
}

Readable.toWeb = function (readable) {
  const iterator = readable[Symbol.asyncIterator]()
  return new ReadableStream({
    pull(controller) {
      return iterator.next().then((step) => {
        if (step.done) controller.close()
        else controller.enqueue(typeof step.value === 'string' ? Buffer.from(step.value) : step.value)
      })
    },
    cancel() {
      readable.destroy()
    }
  })
}

function initWritable(target, options) {
  target._writableState = {
    queue: [],
    writing: false,
    ending: false,
    finished: false,
    objectMode: Boolean(options.objectMode || options.writableObjectMode),
    decodeStrings: options.decodeStrings !== false,
    finalCallbacks: []
  }
  target.writable = true
  if (typeof options.write === 'function') target._write = options.write
  if (typeof options.final === 'function') target._final = options.final
  if (typeof options.destroy === 'function') target._destroy = options.destroy
}

export function Writable(options) {
  if (!(this instanceof Duplex) && !(this instanceof Writable)) return new Writable(options)
  options = options || {}
  Stream.call(this, options)
  this.destroyed = false
  initWritable(this, options)
}
inherit(Writable, Stream)

// A duplex is a Writable too (Node keeps the same check).
Object.defineProperty(Writable, Symbol.hasInstance, {
  value(object) {
    if (Function.prototype[Symbol.hasInstance].call(this, object)) return true
    return this === Writable && Boolean(object && object._writableState)
  }
})

define(Writable.prototype, {
  get writableEnded() {
    return this._writableState.ending
  },
  get writableFinished() {
    return this._writableState.finished
  },
  get writableLength() {
    return this._writableState.queue.length
  },
  get writableNeedDrain() {
    return false
  },
  _write(chunk, encoding, callback) {
    callback()
  },
  write(chunk, encoding, callback) {
    if (typeof encoding === 'function') {
      callback = encoding
      encoding = undefined
    }
    const state = this._writableState
    if (state.ending || this.destroyed) {
      const error = Object.assign(new Error('write after end'), { code: 'ERR_STREAM_WRITE_AFTER_END' })
      queueMicrotask(() => {
        if (callback) callback(error)
        this.emit('error', error)
      })
      return false
    }
    const value = state.objectMode || (typeof chunk === 'string' && !state.decodeStrings) ? chunk : toChunk(chunk, encoding, false)
    state.queue.push({ chunk: value, encoding: typeof value === 'string' ? encoding || 'utf8' : 'buffer', callback })
    this._drainQueue()
    return true
  },
  _drainQueue() {
    const state = this._writableState
    if (state.writing) return
    const entry = state.queue.shift()
    if (!entry) {
      if (state.ending && !state.finished) this._finish()
      return
    }
    state.writing = true
    let sync = true
    const done = (error) => {
      const proceed = () => {
        state.writing = false
        if (entry.callback) entry.callback(error || null)
        if (error) {
          this.destroy(error)
          return
        }
        if (!state.queue.length) this.emit('drain')
        this._drainQueue()
      }
      if (sync) queueMicrotask(proceed)
      else proceed()
    }
    try {
      this._write(entry.chunk, entry.encoding, done)
    } catch (error) {
      done(error)
    }
    sync = false
  },
  _finish() {
    const state = this._writableState
    state.finished = true
    const complete = (error) => {
      if (error) {
        this.destroy(error)
        return
      }
      this.writable = false
      this.emit('finish')
      for (const callback of state.finalCallbacks.splice(0)) callback()
      // A duplex closes once its readable side has ended as well.
      if (!this.destroyed && !this._readableState) {
        this.destroyed = true
        this.emit('close')
      }
    }
    if (this._final) {
      try {
        this._final(complete)
      } catch (error) {
        complete(error)
      }
    } else queueMicrotask(() => complete())
  },
  end(chunk, encoding, callback) {
    if (typeof chunk === 'function') {
      callback = chunk
      chunk = undefined
    } else if (typeof encoding === 'function') {
      callback = encoding
      encoding = undefined
    }
    const state = this._writableState
    if (chunk !== undefined && chunk !== null) this.write(chunk, encoding)
    if (callback) {
      if (state.finished) queueMicrotask(callback)
      else state.finalCallbacks.push(callback)
    }
    if (!state.ending) {
      state.ending = true
      this._drainQueue()
    }
    return this
  },
  cork() {},
  uncork() {},
  setDefaultEncoding() {
    return this
  },
  destroy(error) {
    if (this.destroyed) return this
    this.destroyed = true
    this.writable = false
    const finish = (err) => {
      queueMicrotask(() => {
        if (err) this.emit('error', err)
        this.emit('close')
      })
    }
    if (this._destroy) {
      try {
        this._destroy(error || null, finish)
      } catch (err) {
        finish(err)
      }
    } else finish(error)
    return this
  }
})

export function Duplex(options) {
  if (!(this instanceof Duplex)) return new Duplex(options)
  options = options || {}
  Readable.call(this, options)
  initWritable(this, options)
}
inherit(Duplex, Readable)

for (const name of Object.getOwnPropertyNames(Writable.prototype)) {
  if (name === 'constructor' || name === 'destroy') continue
  if (!Object.prototype.hasOwnProperty.call(Duplex.prototype, name)) {
    Object.defineProperty(Duplex.prototype, name, Object.getOwnPropertyDescriptor(Writable.prototype, name))
  }
}

export function Transform(options) {
  if (!(this instanceof Transform)) return new Transform(options)
  options = options || {}
  Duplex.call(this, options)
  if (typeof options.transform === 'function') this._transform = options.transform
  if (typeof options.flush === 'function') this._flush = options.flush
}
inherit(Transform, Duplex)

define(Transform.prototype, {
  _final(callback) {
    const finish = (error, data) => {
      if (error) {
        callback(error)
        return
      }
      if (data !== undefined && data !== null) this.push(data)
      this.push(null)
      callback()
    }
    if (typeof this._flush === 'function') this._flush(finish)
    else finish()
  },
  _transform(chunk, encoding, callback) {
    callback(null, chunk)
  },
  _write(chunk, encoding, callback) {
    this._transform(chunk, encoding, (error, data) => {
      if (!error && data !== undefined && data !== null) this.push(data)
      callback(error)
    })
  }
})

export function PassThrough(options) {
  if (!(this instanceof PassThrough)) return new PassThrough(options)
  Transform.call(this, options)
}
inherit(PassThrough, Transform)

function eos(stream, callback) {
  let done = false
  const finish = (error) => {
    if (done) return
    done = true
    callback(error || null)
  }
  stream.once('error', finish)
  if (stream._writableState) stream.once('finish', () => finish())
  else stream.once('end', () => finish())
  stream.once('close', () => {
    const writable = stream._writableState
    if (writable && !writable.finished) finish(Object.assign(new Error('Premature close'), { code: 'ERR_STREAM_PREMATURE_CLOSE' }))
    else finish()
  })
  return () => {
    done = true
  }
}

export function finished(stream, options, callback) {
  if (typeof options === 'function') callback = options
  return eos(stream, callback)
}

export function pipeline(...streams) {
  const callback = typeof streams[streams.length - 1] === 'function' ? streams.pop() : null
  const list = Array.isArray(streams[0]) ? streams[0] : streams
  const promise = new Promise((resolve, reject) => {
    let failed = false
    const fail = (error) => {
      if (failed) return
      failed = true
      for (const stream of list) if (stream && typeof stream.destroy === 'function' && !stream.destroyed) stream.destroy()
      reject(error)
    }
    let source = list[0]
    if (source && !(source instanceof Stream) && (source[Symbol.asyncIterator] || source[Symbol.iterator])) source = Readable.from(source)
    for (let i = 1; i < list.length; i++) {
      const target = list[i]
      source.once('error', fail)
      source.pipe(target)
      source = target
    }
    source.once('error', fail)
    eos(source, (error) => {
      if (error) fail(error)
      else resolve()
    })
  })
  if (callback) promise.then(() => callback(), (error) => callback(error))
  return promise
}

export const promises = {
  pipeline: (...streams) => pipeline(...streams),
  finished: (stream, options) => new Promise((resolve, reject) => eos(stream, (error) => (error ? reject(error) : resolve())))
}

export function addAbortSignal(signal, stream) {
  if (signal.aborted) stream.destroy(signal.reason)
  else signal.addEventListener('abort', () => stream.destroy(signal.reason), { once: true })
  return stream
}

export function isReadable(stream) {
  return Boolean(stream && stream.readable && !stream.destroyed)
}

Stream.Stream = Stream
Stream.Readable = Readable
Stream.Writable = Writable
Stream.Duplex = Duplex
Stream.Transform = Transform
Stream.PassThrough = PassThrough
Stream.pipeline = pipeline
Stream.finished = finished
Stream.promises = promises
Stream.addAbortSignal = addAbortSignal
Stream.isReadable = isReadable

export default Stream
