// node:vm. Code runs in the plugin's own QuickJS context (strict mode, its
// own scope); sandbox keys are exposed as variables. This is not a security
// boundary — it only keeps evaluated helpers out of the plugin's globals.
function evaluate(code, sandbox) {
  const names = sandbox && typeof sandbox === 'object' ? Object.keys(sandbox).filter((name) => /^[A-Za-z_$][\w$]*$/.test(name)) : []
  const values = names.map((name) => sandbox[name])
  // eslint-disable-next-line no-new-func
  const runner = new Function(...names, '"use strict"; return eval(arguments[arguments.length - 1])')
  return runner(...values, String(code))
}

export function runInNewContext(code, sandbox) {
  return evaluate(code, sandbox)
}

export function runInContext(code, context) {
  return evaluate(code, context)
}

export function runInThisContext(code) {
  return (0, eval)(String(code))
}

export function createContext(sandbox = {}) {
  return sandbox
}

export function isContext(value) {
  return Boolean(value) && typeof value === 'object'
}

export class Script {
  constructor(code) {
    this._code = String(code)
  }
  runInNewContext(sandbox) {
    return evaluate(this._code, sandbox)
  }
  runInContext(context) {
    return evaluate(this._code, context)
  }
  runInThisContext() {
    return (0, eval)(this._code)
  }
}

export default { runInNewContext, runInContext, runInThisContext, createContext, isContext, Script }
