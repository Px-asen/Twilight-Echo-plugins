// WHATWG URL subset for plugin code: absolute/relative parsing, percent-encoding,
// dot-segment removal and a live searchParams view. IDNA is not applied.

const SPECIAL_PORTS = { 'http:': '80', 'https:': '443', 'ws:': '80', 'wss:': '443', 'ftp:': '21', 'file:': '' }

function isSpecial(protocol) {
  return Object.prototype.hasOwnProperty.call(SPECIAL_PORTS, protocol)
}

function utf8Percent(char) {
  let out = ''
  const code = char.codePointAt(0)
  const bytes = []
  if (code < 0x80) bytes.push(code)
  else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 63))
  else if (code < 0x10000) bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63))
  else bytes.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 63), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63))
  for (const byte of bytes) out += '%' + (byte < 16 ? '0' : '') + byte.toString(16).toUpperCase()
  return out
}

function encodeSet(value, extra) {
  let out = ''
  for (const char of String(value)) {
    const code = char.codePointAt(0)
    if (code <= 0x20 || code >= 0x7f || extra.indexOf(char) >= 0) out += utf8Percent(char)
    else out += char
  }
  return out
}

const PATH_SET = '"#<>?`{}'
const QUERY_SET = '"#<>'
const SPECIAL_QUERY_SET = '"#<>\''
const FRAGMENT_SET = '"<>`'
const USERINFO_SET = '"#<>?`{}/:;=@[\\]^|'

function removeDotSegments(segments) {
  const output = []
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]
    const lower = segment.toLowerCase()
    const isLast = i === segments.length - 1
    if (segment === '..' || lower === '.%2e' || lower === '%2e.' || lower === '%2e%2e') {
      if (output.length) output.pop()
      if (isLast) output.push('')
    } else if (segment === '.' || lower === '%2e') {
      if (isLast) output.push('')
    } else output.push(segment)
  }
  return output
}

function parseHost(raw, special) {
  if (raw.startsWith('[')) {
    if (!raw.endsWith(']')) throw new TypeError('Invalid URL')
    return raw.toLowerCase()
  }
  let host
  try {
    host = decodeURIComponent(raw)
  } catch {
    host = raw
  }
  if (special) host = host.toLowerCase()
  if (special && !host) throw new TypeError('Invalid URL')
  if (/[\s#%/:<>?@[\\\]^|]/.test(host)) throw new TypeError('Invalid URL')
  return host
}

function parseAbsolute(input) {
  const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):([\s\S]*)$/.exec(input)
  if (!match) return null
  const protocol = match[1].toLowerCase() + ':'
  let rest = match[2]
  const special = isSpecial(protocol)
  if (special) rest = rest.replace(/\\/g, '/')
  const record = { protocol, username: '', password: '', hostname: '', port: '', pathname: '', search: '', hash: '', opaque: false }
  const hashIndex = rest.indexOf('#')
  if (hashIndex >= 0) {
    record.hash = rest.slice(hashIndex + 1)
    rest = rest.slice(0, hashIndex)
  }
  const queryIndex = rest.indexOf('?')
  if (queryIndex >= 0) {
    record.search = rest.slice(queryIndex + 1)
    rest = rest.slice(0, queryIndex)
  }
  if (special && protocol !== 'file:') rest = rest.replace(/^\/*/, '//')
  if (rest.startsWith('//')) {
    rest = rest.slice(2)
    const slash = rest.indexOf('/')
    const authority = slash >= 0 ? rest.slice(0, slash) : rest
    rest = slash >= 0 ? rest.slice(slash) : ''
    parseAuthority(record, authority, special)
    record.pathname = rest || (special ? '/' : '')
  } else if (rest.startsWith('/') || special) {
    record.pathname = rest || '/'
  } else {
    record.opaque = true
    record.pathname = rest
  }
  return record
}

function parseAuthority(record, authority, special) {
  let hostPart = authority
  const at = authority.lastIndexOf('@')
  if (at >= 0) {
    const userinfo = authority.slice(0, at)
    hostPart = authority.slice(at + 1)
    const colon = userinfo.indexOf(':')
    record.username = encodeSet(colon >= 0 ? userinfo.slice(0, colon) : userinfo, USERINFO_SET)
    record.password = colon >= 0 ? encodeSet(userinfo.slice(colon + 1), USERINFO_SET) : ''
  }
  let port = ''
  const bracketEnd = hostPart.lastIndexOf(']')
  const colon = hostPart.lastIndexOf(':')
  if (colon > bracketEnd) {
    port = hostPart.slice(colon + 1)
    hostPart = hostPart.slice(0, colon)
    if (port && !/^\d+$/.test(port)) throw new TypeError('Invalid URL')
    if (port) {
      const value = Number(port)
      if (value > 65535) throw new TypeError('Invalid URL')
      port = String(value)
    }
  }
  record.hostname = parseHost(hostPart, special)
  record.port = port === SPECIAL_PORTS[record.protocol] ? '' : port
}

function normalizeRecord(record) {
  const special = isSpecial(record.protocol)
  if (!record.opaque) {
    if (record.pathname || special) {
      const raw = record.pathname.startsWith('/') ? record.pathname.slice(1) : record.pathname
      const normalized = removeDotSegments(raw.split('/')).map((segment) => encodeSet(segment, PATH_SET))
      record.pathname = '/' + normalized.join('/')
    }
  } else {
    record.pathname = encodeSet(record.pathname, '')
  }
  record.search = record.search ? encodeSet(record.search, special ? SPECIAL_QUERY_SET : QUERY_SET) : ''
  record.hash = record.hash ? encodeSet(record.hash, FRAGMENT_SET) : ''
  return record
}

function resolveRelative(input, base) {
  const special = isSpecial(base.protocol)
  let rest = special ? input.replace(/\\/g, '/') : input
  const record = { ...base, opaque: false }
  if (base.opaque) {
    if (rest.startsWith('#')) return { ...base, hash: rest.slice(1) }
    throw new TypeError('Invalid URL')
  }
  if (rest.startsWith('//')) return parseAbsolute(base.protocol + rest)
  let hash = ''
  const hashIndex = rest.indexOf('#')
  if (hashIndex >= 0) {
    hash = rest.slice(hashIndex + 1)
    rest = rest.slice(0, hashIndex)
  }
  let search = null
  const queryIndex = rest.indexOf('?')
  if (queryIndex >= 0) {
    search = rest.slice(queryIndex + 1)
    rest = rest.slice(0, queryIndex)
  }
  record.hash = hash
  if (!rest) {
    record.search = search === null ? base.search : search
    if (search === null && hashIndex < 0) record.hash = base.hash
    return record
  }
  record.search = search === null ? '' : search
  if (rest.startsWith('/')) record.pathname = rest
  else {
    const basePath = base.pathname
    const dir = basePath.slice(0, basePath.lastIndexOf('/') + 1)
    record.pathname = (dir || '/') + rest
  }
  return record
}

function parseUrl(input, base) {
  const text = String(input).replace(/^[\u0000- ]+|[\u0000- ]+$/g, '').replace(/[\t\n\r]/g, '')
  const absolute = parseAbsolute(text)
  if (absolute) {
    if (base && isSpecial(absolute.protocol) && absolute.protocol === base.protocol && absolute.protocol !== 'file:' &&
        !/^[a-zA-Z][a-zA-Z0-9+.-]*:[\\/]{2}/.test(text)) {
      // "http:foo" relative to an http base.
      return normalizeRecord(resolveRelative(text.slice(absolute.protocol.length), base))
    }
    return normalizeRecord(absolute)
  }
  if (!base) throw new TypeError(`Invalid URL: ${input}`)
  return normalizeRecord(resolveRelative(text, base))
}

function serializeQuery(params) {
  return params._list
    .map(([key, value]) => formEncode(key) + '=' + formEncode(value))
    .join('&')
}

function formEncode(value) {
  let out = ''
  for (const char of String(value)) {
    if (/[A-Za-z0-9*\-._]/.test(char)) out += char
    else if (char === ' ') out += '+'
    else out += utf8Percent(char)
  }
  return out
}

function percentDecode(value) {
  const text = String(value)
  if (text.indexOf('%') < 0) return text
  const bytes = []
  let out = ''
  const flush = () => {
    if (!bytes.length) return
    try {
      out += decodeURIComponent(bytes.map((b) => '%' + (b < 16 ? '0' : '') + b.toString(16)).join(''))
    } catch {
      out += bytes.map((b) => String.fromCharCode(b)).join('')
    }
    bytes.length = 0
  }
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (char === '%' && /^[0-9a-fA-F]{2}$/.test(text.substr(i + 1, 2))) {
      bytes.push(parseInt(text.substr(i + 1, 2), 16))
      i += 2
    } else {
      flush()
      out += char
    }
  }
  flush()
  return out
}

function parseQuery(query) {
  const list = []
  const text = String(query).replace(/^\?/, '')
  if (!text) return list
  for (const part of text.split('&')) {
    if (!part) continue
    const eq = part.indexOf('=')
    const key = eq >= 0 ? part.slice(0, eq) : part
    const value = eq >= 0 ? part.slice(eq + 1) : ''
    list.push([percentDecode(key.replace(/\+/g, ' ')), percentDecode(value.replace(/\+/g, ' '))])
  }
  return list
}

export class URLSearchParams {
  constructor(init) {
    this._list = []
    this._url = null
    if (init === undefined || init === null) return
    if (typeof init === 'string') this._list = parseQuery(init)
    else if (init instanceof URLSearchParams) this._list = init._list.map(([k, v]) => [k, v])
    else if (typeof init === 'object' && typeof init[Symbol.iterator] === 'function') {
      for (const pair of init) {
        const entry = Array.from(pair)
        if (entry.length !== 2) throw new TypeError('Each query pair must be an iterable [name, value] tuple')
        this._list.push([String(entry[0]), String(entry[1])])
      }
    } else if (typeof init === 'object') {
      for (const key of Object.keys(init)) this._list.push([key, String(init[key])])
    } else this._list = parseQuery(String(init))
  }
  _update() {
    if (!this._url) return
    const query = serializeQuery(this)
    this._url._record.search = query
  }
  get size() {
    return this._list.length
  }
  append(name, value) {
    this._list.push([String(name), String(value)])
    this._update()
  }
  delete(name, value) {
    const key = String(name)
    this._list = this._list.filter(([k, v]) => k !== key || (value !== undefined && v !== String(value)))
    this._update()
  }
  get(name) {
    const entry = this._list.find(([k]) => k === String(name))
    return entry ? entry[1] : null
  }
  getAll(name) {
    return this._list.filter(([k]) => k === String(name)).map(([, v]) => v)
  }
  has(name, value) {
    return this._list.some(([k, v]) => k === String(name) && (value === undefined || v === String(value)))
  }
  set(name, value) {
    const key = String(name)
    const index = this._list.findIndex(([k]) => k === key)
    if (index < 0) this._list.push([key, String(value)])
    else {
      this._list[index] = [key, String(value)]
      this._list = this._list.filter(([k], i) => k !== key || i === index)
    }
    this._update()
  }
  sort() {
    this._list = this._list
      .map((entry, index) => ({ entry, index }))
      .sort((a, b) => (a.entry[0] < b.entry[0] ? -1 : a.entry[0] > b.entry[0] ? 1 : a.index - b.index))
      .map(({ entry }) => entry)
    this._update()
  }
  forEach(callback, thisArg) {
    for (const [key, value] of this._list) callback.call(thisArg, value, key, this)
  }
  *keys() {
    for (const [key] of this._list) yield key
  }
  *values() {
    for (const [, value] of this._list) yield value
  }
  *entries() {
    for (const [key, value] of this._list) yield [key, value]
  }
  [Symbol.iterator]() {
    return this.entries()
  }
  toString() {
    return serializeQuery(this)
  }
}

export class URL {
  constructor(input, base) {
    let baseRecord = null
    if (base !== undefined && base !== null) baseRecord = base instanceof URL ? base._record : parseUrl(String(base))
    this._record = parseUrl(input instanceof URL ? input.href : String(input), baseRecord)
    this._params = new URLSearchParams(this._record.search)
    this._params._url = this
  }
  static canParse(input, base) {
    try {
      new URL(input, base)
      return true
    } catch {
      return false
    }
  }
  static parse(input, base) {
    try {
      return new URL(input, base)
    } catch {
      return null
    }
  }
  get href() {
    const r = this._record
    let out = r.protocol
    const hasAuthority = !r.opaque && (r.hostname || isSpecial(r.protocol))
    if (hasAuthority) {
      out += '//'
      if (r.username || r.password) out += r.username + (r.password ? ':' + r.password : '') + '@'
      out += r.hostname + (r.port ? ':' + r.port : '')
    }
    out += r.pathname
    if (r.search) out += '?' + r.search
    if (r.hash) out += '#' + r.hash
    return out
  }
  set href(value) {
    this._record = parseUrl(String(value))
    this._params._list = parseQuery(this._record.search)
  }
  get origin() {
    const r = this._record
    if (!isSpecial(r.protocol) || r.protocol === 'file:') return 'null'
    return r.protocol + '//' + r.hostname + (r.port ? ':' + r.port : '')
  }
  get protocol() {
    return this._record.protocol
  }
  set protocol(value) {
    const next = String(value).replace(/:.*$/, '').toLowerCase() + ':'
    if (/^[a-z][a-z0-9+.-]*:$/.test(next) && isSpecial(next) === isSpecial(this._record.protocol)) {
      this._record.protocol = next
      if (this._record.port === SPECIAL_PORTS[next]) this._record.port = ''
    }
  }
  get username() {
    return this._record.username
  }
  set username(value) {
    this._record.username = encodeSet(value, USERINFO_SET)
  }
  get password() {
    return this._record.password
  }
  set password(value) {
    this._record.password = encodeSet(value, USERINFO_SET)
  }
  get host() {
    return this._record.hostname + (this._record.port ? ':' + this._record.port : '')
  }
  set host(value) {
    const record = { ...this._record }
    parseAuthority(record, String(value), isSpecial(record.protocol))
    this._record.hostname = record.hostname
    this._record.port = record.port
  }
  get hostname() {
    return this._record.hostname
  }
  set hostname(value) {
    this._record.hostname = parseHost(String(value), isSpecial(this._record.protocol))
  }
  get port() {
    return this._record.port
  }
  set port(value) {
    const text = String(value)
    if (text === '') this._record.port = ''
    else if (/^\d+$/.test(text) && Number(text) <= 65535) {
      const port = String(Number(text))
      this._record.port = port === SPECIAL_PORTS[this._record.protocol] ? '' : port
    }
  }
  get pathname() {
    return this._record.pathname
  }
  set pathname(value) {
    if (this._record.opaque) return
    const record = { ...this._record, pathname: String(value).startsWith('/') ? String(value) : '/' + value }
    this._record.pathname = normalizeRecord({ ...record, search: '', hash: '' }).pathname
  }
  get search() {
    return this._record.search ? '?' + this._record.search : ''
  }
  set search(value) {
    const text = String(value).replace(/^\?/, '')
    this._record.search = text ? encodeSet(text, isSpecial(this._record.protocol) ? SPECIAL_QUERY_SET : QUERY_SET) : ''
    this._params._list = parseQuery(this._record.search)
  }
  get searchParams() {
    return this._params
  }
  get hash() {
    return this._record.hash ? '#' + this._record.hash : ''
  }
  set hash(value) {
    const text = String(value).replace(/^#/, '')
    this._record.hash = text ? encodeSet(text, FRAGMENT_SET) : ''
  }
  toString() {
    return this.href
  }
  toJSON() {
    return this.href
  }
}

Object.defineProperty(URL.prototype, Symbol.toStringTag, { value: 'URL' })
Object.defineProperty(URLSearchParams.prototype, Symbol.toStringTag, { value: 'URLSearchParams' })
