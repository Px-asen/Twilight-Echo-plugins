/** Cancellation boundaries shared by network, tools and local scans. */
export function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason ?? new DOMException('已停止', 'AbortError')
}

export function abortable(promise, signal) {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException('已停止', 'AbortError'))
  return new Promise((resolve, reject) => {
    const onAbort = () => finish(reject, signal.reason ?? new DOMException('已停止', 'AbortError'))
    const finish = (settle, value) => {
      signal.removeEventListener('abort', onAbort)
      settle(value)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    Promise.resolve(promise).then(value => finish(resolve, value), error => finish(reject, error))
  })
}
