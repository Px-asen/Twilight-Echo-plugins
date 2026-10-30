import { URL, URLSearchParams } from '../runtime/url.js'
import querystring from './querystring.js'

export { URL, URLSearchParams }

export function fileURLToPath(value) {
  const url = typeof value === 'string' ? new URL(value) : value
  if (url.protocol !== 'file:') throw new TypeError('The URL must be of scheme file')
  return decodeURIComponent(url.pathname)
}

export function pathToFileURL(path) {
  const text = String(path)
  return new URL('file://' + encodeURI(text.startsWith('/') ? text : '/' + text))
}

export function domainToASCII(domain) {
  return String(domain).toLowerCase()
}

export function domainToUnicode(domain) {
  return String(domain)
}

// Legacy url.parse / url.format / url.resolve.
export function Url() {}

export function parse(input, parseQueryString) {
  const text = String(input).trim()
  const result = new Url()
  const match = /^([a-zA-Z][a-zA-Z0-9+.-]*:)?(\/\/([^/?#]*))?([^?#]*)(\?[^#]*)?(#.*)?$/.exec(text) || []
  result.protocol = match[1] ? match[1].toLowerCase() : null
  result.slashes = match[2] ? true : null
  const authority = match[3] || ''
  const at = authority.lastIndexOf('@')
  result.auth = at >= 0 ? decodeURIComponent(authority.slice(0, at)) : null
  const hostPart = at >= 0 ? authority.slice(at + 1) : authority
  result.host = hostPart ? hostPart.toLowerCase() : null
  const portMatch = /:(\d*)$/.exec(hostPart)
  result.port = portMatch && portMatch[1] ? portMatch[1] : null
  result.hostname = hostPart ? hostPart.replace(/:\d*$/, '').replace(/^\[|\]$/g, '').toLowerCase() : null
  result.pathname = match[4] || (result.slashes ? '/' : null)
  result.search = match[5] || null
  result.query = match[5] ? match[5].slice(1) : null
  if (parseQueryString) result.query = querystring.parse(result.query || '')
  result.hash = match[6] || null
  result.path = (result.pathname || '') + (result.search || '') || null
  result.href = format(result)
  return result
}

export function format(object) {
  if (typeof object === 'string') return format(parse(object))
  if (object instanceof URL) return object.href
  let out = object.protocol || ''
  if (out && !out.endsWith(':')) out += ':'
  if (object.slashes || /^(https?|ftp|file|wss?):?$/.test(object.protocol || '')) out += '//'
  if (object.auth) out += encodeURIComponent(object.auth).replace(/%3A/i, ':') + '@'
  if (object.host) out += object.host
  else if (object.hostname) out += object.hostname + (object.port ? ':' + object.port : '')
  out += object.pathname || ''
  if (object.search) out += object.search.startsWith('?') ? object.search : '?' + object.search
  else if (object.query && typeof object.query === 'object') {
    const query = querystring.stringify(object.query)
    if (query) out += '?' + query
  } else if (typeof object.query === 'string' && object.query) out += '?' + object.query
  if (object.hash) out += object.hash.startsWith('#') ? object.hash : '#' + object.hash
  return out
}

export function resolve(from, to) {
  const base = new URL(from, 'resolve://host/')
  const resolved = new URL(to, base)
  return resolved.protocol === 'resolve:' ? resolved.href.slice('resolve://host'.length) : resolved.href
}

export default { URL, URLSearchParams, Url, parse, format, resolve, fileURLToPath, pathToFileURL, domainToASCII, domainToUnicode }
