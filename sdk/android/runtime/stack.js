// QuickJS exposes stack frames as text, not V8 CallSites. Node dependencies
// such as Express's depd use prepareStackTrace to request structured frames.
export function parseStackTrace(stack) {
  return String(stack || '').split('\n').filter((line) => /^\s*at /.test(line)).map((line) => {
    const text = line.trim().slice(3)
    const named = /^(.*?) \((.*)\)$/.exec(text)
    const name = named ? named[1] : null
    const location = named ? named[2] : text
    const position = /^(.*):(\d+):(\d+)$/.exec(location) || /^(.*):(\d+)$/.exec(location)
    const file = position ? position[1] : location === 'native' ? null : location
    return {
      getFileName: () => file,
      getLineNumber: () => position ? Number(position[2]) : null,
      getColumnNumber: () => position && position[3] ? Number(position[3]) : null,
      getFunctionName: () => name,
      // QuickJS does not expose receivers or method metadata in its stack.
      getThis: () => undefined,
      getTypeName: () => null,
      getMethodName: () => null,
      isEval: () => name === '<eval>',
      getEvalOrigin: () => name === '<eval>' ? location : undefined,
      toString: () => text
    }
  })
}

export function captureStackTrace(target, constructorOpt) {
  if (!target || (typeof target !== 'object' && typeof target !== 'function')) return
  let frames = parseStackTrace(new Error().stack)
  // The first frame belongs to this function, not its caller.
  frames.shift()
  if (typeof constructorOpt === 'function' && constructorOpt.name) {
    const index = frames.findIndex((frame) => frame.getFunctionName() === constructorOpt.name)
    if (index >= 0) frames = frames.slice(index + 1)
  }
  const limit = typeof Error.stackTraceLimit === 'number' ? Error.stackTraceLimit : 10
  frames = frames.slice(0, Math.max(0, limit))
  let formatted = false
  let value
  try {
    Object.defineProperty(target, 'stack', {
      configurable: true,
      enumerable: false,
      get() {
        if (!formatted) {
          value = typeof Error.prepareStackTrace === 'function'
            ? Error.prepareStackTrace(target, frames)
            : [Error.prototype.toString.call(target), ...frames.map((frame) => `    at ${frame}`)].join('\n')
          formatted = true
        }
        return value
      },
      set(stack) {
        value = stack
        formatted = true
      }
    })
  } catch {
    // Frozen errors keep their own stack.
  }
}
