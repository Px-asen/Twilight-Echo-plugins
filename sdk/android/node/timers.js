import {
  TwilightPromise as Promise,
  clearImmediate,
  clearInterval,
  clearTimeout,
  setImmediate,
  setInterval,
  setTimeout
} from '../runtime/loop.js'

export { setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, clearImmediate }

function abortable(signal, start) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(signal.reason)
      return
    }
    const cancel = start(resolve)
    if (signal) {
      signal.addEventListener(
        'abort',
        () => {
          cancel()
          reject(signal.reason)
        },
        { once: true }
      )
    }
  })
}

export const promises = {
  setTimeout(delay, value, options = {}) {
    return abortable(options.signal, (resolve) => {
      const timer = setTimeout(() => resolve(value), delay)
      return () => clearTimeout(timer)
    })
  },
  setImmediate(value, options = {}) {
    return abortable(options.signal, (resolve) => {
      const immediate = setImmediate(() => resolve(value))
      return () => clearImmediate(immediate)
    })
  },
  scheduler: {
    wait(delay, options = {}) {
      return promises.setTimeout(delay, undefined, options)
    },
    yield() {
      return promises.setImmediate()
    }
  }
}

export default { setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, clearImmediate, promises }
