function encode(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => '%' + char.charCodeAt(0).toString(16).toUpperCase())
}

function decode(value) {
  const text = String(value).replace(/\+/g, ' ')
  try {
    return decodeURIComponent(text)
  } catch {
    return text.replace(/%([0-9a-fA-F]{2})/g, (match, hex) => {
      try {
        return decodeURIComponent(match)
      } catch {
        return String.fromCharCode(parseInt(hex, 16))
      }
    })
  }
}

function stringifyPrimitive(value) {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && isFinite(value)) return String(value)
  if (typeof value === 'bigint') return String(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  return ''
}

export function stringify(object, sep = '&', eq = '=', options) {
  if (!object || typeof object !== 'object') return ''
  const encoder = (options && options.encodeURIComponent) || encode
  const parts = []
  for (const key of Object.keys(object)) {
    const value = object[key]
    const name = encoder(stringifyPrimitive(key))
    if (Array.isArray(value)) for (const item of value) parts.push(name + eq + encoder(stringifyPrimitive(item)))
    else parts.push(name + eq + encoder(stringifyPrimitive(value)))
  }
  return parts.join(sep)
}

export function parse(text, sep = '&', eq = '=', options) {
  const out = Object.create(null)
  if (typeof text !== 'string' || !text) return out
  const decoder = (options && options.decodeURIComponent) || decode
  const max = options && options.maxKeys !== undefined ? options.maxKeys : 1000
  let parts = text.split(sep)
  if (max > 0) parts = parts.slice(0, max)
  for (const part of parts) {
    if (!part) continue
    const index = part.indexOf(eq)
    const key = decoder(index >= 0 ? part.slice(0, index) : part)
    const value = index >= 0 ? decoder(part.slice(index + eq.length)) : ''
    if (!(key in out)) out[key] = value
    else if (Array.isArray(out[key])) out[key].push(value)
    else out[key] = [out[key], value]
  }
  return out
}

export const escape = encode
export const unescape = decode
export { stringify as encode, parse as decode }

export default { stringify, parse, escape, unescape, encode: stringify, decode: parse }
