import { createHash, randomBytes } from 'node:crypto'

const PROVIDER_ID = 'navidrome'
const SUBSONIC_VERSION = '1.16.1'
const CLIENT_NAME = 'Twilight Echo'
const SERVER_URL_KEY = 'serverUrl'
const USERNAME_KEY = 'username'
const PASSWORD_KEY = 'password'

let contextRef = null

export async function activate(context) {
  contextRef = context
  await context.twilight.providers.register({
    id: PROVIDER_ID,
    name: 'Navidrome',
    capabilities: ['search', 'playbackUrl', 'lyrics', 'cover', 'playlist', 'library', 'login'],
    ui: {
      icon: 'pi pi-server',
      color: '#f59e0b',
      description: '连接你的 Navidrome 音乐服务器',
      authType: 'settings',
      loginInstructions: '输入 Navidrome 服务器地址和账号即可连接',
      streamingHome: { requiresLogin: true },
      streamingLibraryTab: true,
      streamingSearch: true,
      unifiedLibrary: true
    },
    checkLogin,
    getProfile,
    loginWithServer,
    logout,
    searchSongs,
    searchAlbums,
    searchPlaylists,
    getPlaybackUrl,
    getLyrics,
    fetchUserLibrary,
    fetchPlaylistTracks,
    fetchPlaylistTracksPage,
    fetchAlbumTracks
  })
  context.logger.info('Navidrome provider registered')
}

export function deactivate() {
  contextRef = null
}

function getContext() {
  if (!contextRef) throw new Error('Navidrome provider is not active')
  return contextRef
}

async function getConfig() {
  const context = getContext()
  const serverUrl = await context.settings.get(SERVER_URL_KEY)
  const username = await context.settings.get(USERNAME_KEY)
  const password = await context.settings.get(PASSWORD_KEY)
  if (
    typeof serverUrl !== 'string' ||
    typeof username !== 'string' ||
    typeof password !== 'string'
  ) {
    return null
  }
  if (!serverUrl.trim() || !username.trim()) return null
  return { serverUrl: normalizeServerUrl(serverUrl), username: username.trim(), password }
}

function normalizeServerUrl(value) {
  const trimmed = String(value ?? '')
    .trim()
    .replace(/\/+$/, '')
  if (!trimmed) throw new Error('Navidrome 服务器地址不能为空')
  let parsed
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new Error('Navidrome 服务器地址无效')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Navidrome 服务器地址必须使用 HTTP 或 HTTPS')
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('Navidrome 服务器地址不能包含账号、密码或查询参数')
  }
  const pathname = parsed.pathname.replace(/\/+$/, '').replace(/\/rest$/, '')
  return `${parsed.origin}${pathname}`
}

function authParams(config) {
  const salt = randomBytes(12).toString('hex')
  const token = createHash('md5').update(`${config.password}${salt}`).digest('hex')
  return {
    u: config.username,
    s: salt,
    t: token,
    v: SUBSONIC_VERSION,
    c: CLIENT_NAME,
    f: 'json'
  }
}

function endpointUrl(config, endpoint, params = {}) {
  const url = new URL(`${config.serverUrl}/rest/${endpoint}.view`)
  for (const [key, value] of Object.entries({ ...authParams(config), ...params })) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value))
  }
  return url
}

async function requestWithConfig(config, endpoint, params = {}, signal) {
  const response = await fetch(endpointUrl(config, endpoint, params), {
    signal,
    headers: { Accept: 'application/json' }
  })
  let payload
  try {
    payload = await response.json()
  } catch {
    throw new Error(`Navidrome 返回了无效响应（HTTP ${response.status}）`)
  }
  const envelope = payload?.['subsonic-response']
  if (!response.ok || !envelope || envelope.status !== 'ok') {
    const error = envelope?.error
    throw new Error(error?.message || `Navidrome 请求失败（HTTP ${response.status}）`)
  }
  return envelope
}

async function request(endpoint, params = {}, signal) {
  const config = await getConfig()
  if (!config) throw new Error('请先配置 Navidrome 服务器')
  return requestWithConfig(config, endpoint, params, signal)
}

function providerId(id) {
  return `${PROVIDER_ID}:${String(id)}`
}

function localId(track) {
  const value = String(track?.id ?? '')
  return value.startsWith(`${PROVIDER_ID}:`) ? value.slice(PROVIDER_ID.length + 1) : value
}

function coverUrl(config, coverArt) {
  if (!coverArt) return null
  return endpointUrl(config, 'getCoverArt', { id: coverArt, size: 600 }).toString()
}

function mapSong(song, config) {
  if (!song || (song.id === undefined && song.songId === undefined)) return null
  const id = String(song.id ?? song.songId)
  const artist = String(song.artist ?? song.artistName ?? song.albumArtist ?? '')
  const album = String(song.album ?? '')
  return {
    id: providerId(id),
    source: PROVIDER_ID,
    title: String(song.title ?? song.name ?? id),
    artist,
    album,
    albumArtist: song.albumArtist ? String(song.albumArtist) : undefined,
    albumId: song.albumId == null ? undefined : String(song.albumId),
    trackNumber: numberOrUndefined(song.track),
    discNumber: numberOrUndefined(song.discNumber),
    releaseDate: song.year ? String(song.year) : undefined,
    filePath: providerId(id),
    fileName: String(song.title ?? song.name ?? id),
    duration: numberOrZero(song.duration),
    size: numberOrZero(song.size),
    cover: coverUrl(config, song.coverArt ?? id),
    lyrics: null,
    format: song.suffix ? String(song.suffix) : undefined,
    bitrate: numberOrUndefined(song.bitRate)
  }
}

function numberOrZero(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : 0
}

function numberOrUndefined(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : undefined
}

function pageWindow(limit, offset) {
  const size = Number(limit)
  const start = Number(offset)
  return {
    size: Number.isFinite(size) ? Math.max(1, Math.min(100, Math.floor(size) || 20)) : 20,
    start: Number.isFinite(start) ? Math.max(0, Math.floor(start)) : 0
  }
}

function searchPage(entries, size, start, mapItem) {
  const results = Array.isArray(entries) ? entries : []
  // Subsonic search3 has no total count. One extra result keeps the next page reachable.
  return {
    items: results.slice(0, size).map(mapItem).filter(Boolean),
    total: start + Math.min(size, results.length) + (results.length > size ? 1 : 0)
  }
}

function profileFromUser(user) {
  if (!user) return null
  return {
    userId: String(user.username ?? user.email ?? ''),
    nickname: String(user.username ?? user.email ?? 'Navidrome 用户'),
    avatarUrl: ''
  }
}

export async function checkLogin(context) {
  let config
  try {
    config = await getConfig()
  } catch {
    return { loggedIn: false, profile: null }
  }
  if (!config) return { loggedIn: false, profile: null }
  try {
    const response = await requestWithConfig(
      config,
      'getUser',
      { username: config.username },
      context?.signal
    )
    return { loggedIn: true, profile: profileFromUser(response.user) }
  } catch {
    return { loggedIn: false, profile: null }
  }
}

export async function getProfile(context) {
  const result = await checkLogin(context)
  return result.profile
}

export async function loginWithServer(serverUrl, username, password, context) {
  const config = {
    serverUrl: normalizeServerUrl(serverUrl),
    username: String(username ?? '').trim(),
    password: String(password ?? '')
  }
  if (!config.username) throw new Error('Navidrome 用户名不能为空')
  if (!config.password) throw new Error('Navidrome 密码不能为空')
  const response = await requestWithConfig(
    config,
    'getUser',
    { username: config.username },
    context?.signal
  )
  const settings = getContext().settings
  await settings.set(SERVER_URL_KEY, config.serverUrl)
  await settings.set(USERNAME_KEY, config.username)
  await settings.set(PASSWORD_KEY, config.password)
  return { loggedIn: true, profile: profileFromUser(response.user) }
}

export async function logout() {
  const settings = getContext().settings
  await settings.delete(SERVER_URL_KEY)
  await settings.delete(USERNAME_KEY)
  await settings.delete(PASSWORD_KEY)
}

export async function searchSongs(keywords, limit = 20, offset = 0, context) {
  const { size, start } = pageWindow(limit, offset)
  const response = await request(
    'search3',
    {
      query: String(keywords ?? '').trim(),
      artistCount: 0,
      albumCount: 0,
      songCount: size + 1,
      songOffset: start
    },
    context?.signal
  )
  const result = response.searchResult3 ?? {}
  const config = await getConfig()
  return searchPage(result.song, size, start, (song) => mapSong(song, config))
}

export async function searchAlbums(keywords, limit = 20, offset = 0, context) {
  const { size, start } = pageWindow(limit, offset)
  const response = await request(
    'search3',
    {
      query: String(keywords ?? '').trim(),
      artistCount: 0,
      albumCount: size + 1,
      albumOffset: start,
      songCount: 0
    },
    context?.signal
  )
  const result = response.searchResult3 ?? {}
  const config = await getConfig()
  return searchPage(result.album, size, start, (album) => ({
    id: String(album.id ?? album.name),
    name: String(album.name ?? ''),
    artist: String(album.artist ?? album.albumArtist ?? ''),
    cover: coverUrl(config, album.coverArt ?? album.id),
    trackCount: numberOrZero(album.songCount ?? album.size),
    publishTime: album.year ? Date.UTC(Number(album.year), 0, 1) : undefined
  }))
}

export async function getPlaybackUrl(track, options = {}, _context) {
  const config = await getConfig()
  if (!config) throw new Error('请先配置 Navidrome 服务器')
  const params = { id: localId(track), estimateContentLength: 'true' }
  if (/^\d+$/.test(String(options.quality ?? ''))) params.maxBitRate = options.quality
  return endpointUrl(config, 'stream', params).toString()
}

export async function getLyrics(track, context) {
  let response
  try {
    response = await request('getLyricsBySongId', { id: localId(track) }, context?.signal)
  } catch (error) {
    // Older Subsonic servers expose only the artist/title lyrics endpoint.
    if (context?.signal?.aborted) throw error
    response = await request(
      'getLyrics',
      { artist: track?.artist ?? '', title: track?.title ?? '' },
      context?.signal
    )
  }
  const entries = response.lyricsList?.structuredLyrics
  if (Array.isArray(entries) && entries.length) {
    const ordered = [...entries].sort(
      (a, b) => Number(b.synced === true) - Number(a.synced === true)
    )
    for (const entry of ordered) {
      const lines = Array.isArray(entry.line)
        ? entry.line
        : Array.isArray(entry.lines)
          ? entry.lines
          : []
      const offset = Number(entry.offset) || 0
      const lyrics = lines
        .map((line) => {
          const value = String(line.value ?? line.text ?? '')
          if (!value) return ''
          if (!entry.synced || line.start == null || !Number.isFinite(Number(line.start))) {
            return value
          }
          const time = Math.max(0, Math.round(Number(line.start) - offset))
          const minutes = String(Math.floor(time / 60000)).padStart(2, '0')
          const seconds = String(Math.floor((time % 60000) / 1000)).padStart(2, '0')
          const milliseconds = String(time % 1000).padStart(3, '0')
          return `[${minutes}:${seconds}.${milliseconds}]${value}`
        })
        .filter(Boolean)
        .join('\n')
      if (lyrics) return { lyrics, translatedLyrics: null }
    }
  }
  const legacy = response.lyrics
  return { lyrics: legacy?.value ? String(legacy.value) : null, translatedLyrics: null }
}

function playlistSummary(playlist, config) {
  return {
    id: String(playlist.id),
    name: String(playlist.name ?? '未命名歌单'),
    cover: coverUrl(config, playlist.coverArt ?? playlist.id),
    trackCount: numberOrZero(playlist.songCount),
    creatorName: playlist.owner ? String(playlist.owner) : undefined,
    owned: playlist.owner === config.username
  }
}

export async function fetchUserLibrary(_force, context) {
  const [response, config] = await Promise.all([
    request('getPlaylists', {}, context?.signal),
    getConfig()
  ])
  const playlists = (
    Array.isArray(response.playlists?.playlist) ? response.playlists.playlist : []
  ).map((playlist) => playlistSummary(playlist, config))
  return { likedPlaylist: null, playlists }
}

export async function searchPlaylists(keywords, limit = 20, offset = 0, context) {
  const response = await request('getPlaylists', {}, context?.signal)
  const config = await getConfig()
  const query = String(keywords ?? '')
    .trim()
    .toLocaleLowerCase()
  const all = (Array.isArray(response.playlists?.playlist) ? response.playlists.playlist : [])
    .filter((playlist) => {
      if (!query) return true
      return String(playlist.name ?? '')
        .toLocaleLowerCase()
        .includes(query)
    })
    .map((playlist) => playlistSummary(playlist, config))
  const { start, size } = pageWindow(limit, offset)
  return { items: all.slice(start, start + size), total: all.length }
}

export async function fetchPlaylistTracks(playlistId, _force, context) {
  const response = await request('getPlaylist', { id: String(playlistId) }, context?.signal)
  const config = await getConfig()
  return (Array.isArray(response.playlist?.entry) ? response.playlist.entry : [])
    .map((song) => mapSong(song, config))
    .filter(Boolean)
}

export async function fetchPlaylistTracksPage(
  playlistId,
  offset = 0,
  limit = 20,
  force = false,
  context
) {
  const tracks = await fetchPlaylistTracks(playlistId, force, context)
  const { start, size } = pageWindow(limit, offset)
  const page = tracks.slice(start, start + size)
  return {
    tracks: page,
    total: tracks.length,
    nextOffset: start + page.length,
    hasMore: start + page.length < tracks.length
  }
}

export async function fetchAlbumTracks(albumId, context) {
  const response = await request('getAlbum', { id: String(albumId) }, context?.signal)
  const config = await getConfig()
  return (Array.isArray(response.album?.song) ? response.album.song : [])
    .map((song) => mapSong(song, config))
    .filter(Boolean)
}
