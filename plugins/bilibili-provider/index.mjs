import { createHash, randomBytes } from 'crypto'
import { createServer } from 'http'
import { pipeline } from 'stream/promises'
import { Readable } from 'stream'

const PROVIDER_ID = 'bili'
const SETTINGS_AUTH_KEY = 'auth'
const SETTINGS_PINNED_FAVORITE_KEY = 'pinnedFavoriteFolderId'
const SETTINGS_PINNED_FAVORITES_KEY = 'pinnedFavoriteFolderIds'
const SET_PINNED_FAVORITE_COMMAND = 'bilibili.setPinnedFavoriteFolder'
const BILI_REFERER = 'https://www.bilibili.com/'
const BILI_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const QR_EXPIRES_SECONDS = 180
// Stream tokens must outlive the whole playback session: the native engine
// re-opens the same proxy URL for seeks long after getPlaybackUrl returned.
const STREAM_PROXY_TOKEN_TTL_MS = 6 * 60 * 60 * 1000
const IMAGE_PROXY_TOKEN_TTL_MS = 6 * 60 * 60 * 1000
// Keep the worst-case getPlaybackUrl chain (nav + refresh probe + two playurl
// calls) below the host's 30s provider RPC timeout.
const BILI_REQUEST_TIMEOUT_MS = 10000
const PLAYURL_TIMEOUT_MS = 8000
const COOKIE_REFRESH_TIMEOUT_MS = 5000
const PROFILE_REQUEST_TIMEOUT_MS = 3000
// Time to receive upstream response headers before moving to the next CDN
// candidate. Bilibili regularly routes playurl responses to P2P edge nodes
// that accept the connection and then never answer.
const STREAM_CANDIDATE_TIMEOUT_MS = 15000
const LOGIN_CHECK_CACHE_TTL_MS = 60 * 1000
const LOGIN_CHECK_TIMEOUT_MS = 12500
const LOGIN_CHECK_STALE_TTL_MS = 5 * 60 * 1000
const WBI_KEYS_CACHE_TTL_MS = 10 * 60 * 1000
const DEVICE_COOKIE_TIMEOUT_MS = 3000
const MAX_FAVORITE_PAGES = 50
const PAGE_SIZE = 20
const FAVORITE_PAGE_CONCURRENCY = 1
// Leave time for IPC serialization before the host's 120s library RPC limit.
const FAVORITE_LOAD_TIMEOUT_MS = 105000
const PLAYBACK_LOAD_TIMEOUT_MS = 27000
const VIDEO_VIEW_CONCURRENCY = 2
const MAX_FAVORITE_PAGE_CACHE_ENTRIES = 300
const FAVORITE_CACHE_TTL_MS = 10 * 60 * 1000
const FAVORITE_CACHE_STALE_TTL_MS = 60 * 60 * 1000
const SEARCH_DEFAULT_LIMIT = 30
const SEARCH_PAGE_SIZE = 20
const SEARCH_VIEW_CONCURRENCY = 6
const COOKIE_REFRESH_CHECK_INTERVAL_MS = 5 * 60 * 1000
const WBI_MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
  37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
  22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52
]

let pluginContext = null
let proxyServer = null
let proxyServerStart = null
let proxyPort = 0
const proxyTokens = new Map()
const favoriteTrackCache = new Map()
const favoriteTrackRequests = new Map()
const favoritePageCache = new Map()
const favoritePageRequests = new Map()
const favoriteFolderVersions = new Map()
const favoriteLibraryRequests = new Map()
const loginCheckRequests = new Map()
let cookieRefreshCheckedAt = 0
// Login state and WBI keys are cached so the getPlaybackUrl hot path does not
// spend two nav round-trips per track switch; a slow nav chain used to push
// the call past the host RPC timeout and open the plugin circuit breaker.
let loginStateCache = null
let wbiKeysCache = null

export async function activate(context) {
  pluginContext = context
  context.logger.info('Registering Bilibili favorites provider')
  await context.twilight.providers.register({
    id: PROVIDER_ID,
    name: 'Bilibili',
    capabilities: ['login', 'playlist', 'library', 'search', 'playbackUrl', 'cover'],
    ui: {
      icon: 'pi pi-video',
      color: '#00a1d6',
      description: '收藏夹视频音频',
      authType: 'qr',
      loginInstructions: '请使用哔哩哔哩 App 扫码登录',
      qrStatusCodes: { waiting: 86101, scanned: 86090, expired: 86038, success: 0 },
      streamingLibraryTab: true
    },
    checkLogin,
    getProfile,
    logout,
    getQrLogin,
    getQrKey: () => getQrLogin().then((login) => login.key),
    getQrImage: async () => null,
    checkQrLogin,
    fetchUserLibrary,
    fetchPlaylistTracks,
    fetchPlaylistTracksPage,
    searchSongs,
    getPlaybackUrl,
    // The renderer exposes every method matching this plugin's declared
    // capabilities, and the host circuit breaker counts an unimplemented RPC
    // as a plugin failure. Read-only capability probes must therefore resolve
    // harmlessly instead of erroring.
    searchArtists: async () => ({ items: [], total: 0 }),
    searchPlaylists: async () => ({ items: [], total: 0 }),
    fetchLikedTracks: async () => [],
    fetchRecommendSongs: async () => [],
    fetchRecommendPlaylists: async () => [],
    fetchPersonalFm: async () => [],
    fetchPrivateContent: async () => [],
    fetchArtistTopSongs: async () => [],
    fetchArtistAlbums: async () => [],
    fetchArtistIntro: async () => '',
    fetchArtistFollowState: async () => null,
    fetchAlbumTracks: async () => [],
    fetchArtistPlaylists: async () => [],
    fetchUserPlaylistsByUid: async () => [],
    fetchUserFollows: async () => [],
    fetchUserFolloweds: async () => [],
    fetchPlayRecords: async () => [],
    fetchRecentSongs: async () => [],
    followArtist: async () => undefined,
    followUser: async () => undefined,
    likeTrack: async () => undefined,
    isTrackLiked: async () => false,
    // Playlist editing has no Bilibili counterpart; fail these explicit user
    // actions with a clear message rather than pretending they succeeded.
    createPlaylist: async () => {
      throw new Error('Bilibili 音源不支持创建歌单')
    },
    deletePlaylist: async () => {
      throw new Error('Bilibili 音源不支持删除歌单')
    },
    addTracksToPlaylist: async () => {
      throw new Error('Bilibili 音源不支持添加到歌单')
    },
    removeTracksFromPlaylist: async () => {
      throw new Error('Bilibili 音源不支持从歌单移除')
    }
  })
  await context.twilight.ui.register({
    id: 'bilibili-account',
    kind: 'settingsPanel',
    title: 'Bilibili 账号',
    description: '登录后可在流媒体页播放收藏夹视频的音频',
    command: SET_PINNED_FAVORITE_COMMAND
  })
  context.twilight.ui.onCommand(SET_PINNED_FAVORITE_COMMAND, setPinnedFavoriteFolder)
}

export async function deactivate() {
  proxyTokens.clear()
  favoriteTrackCache.clear()
  favoriteTrackRequests.clear()
  favoritePageCache.clear()
  favoritePageRequests.clear()
  favoriteFolderVersions.clear()
  favoriteLibraryRequests.clear()
  loginCheckRequests.clear()
  cookieRefreshCheckedAt = 0
  loginStateCache = null
  wbiKeysCache = null
  if (proxyServer) {
    await new Promise((resolve) => proxyServer.close(resolve))
    proxyServer = null
    proxyPort = 0
  }
  proxyServerStart = null
  pluginContext = null
}

async function checkLogin() {
  const auth = await readAuth()
  if (!auth?.cookie) {
    loginStateCache = null
    return { loggedIn: false, profile: null }
  }
  if (
    loginStateCache &&
    loginStateCache.cookie === auth.cookie &&
    Date.now() < loginStateCache.expiresAt
  ) {
    return { loggedIn: true, profile: loginStateCache.profile }
  }
  return shareRequest(loginCheckRequests, auth.cookie, () => checkLoginWithAuth(auth))
}

async function checkLoginWithAuth(auth) {
  const deadline = Date.now() + LOGIN_CHECK_TIMEOUT_MS
  try {
    const nav = await biliJson('https://api.bilibili.com/x/web-interface/nav', {
      cookie: auth.cookie, retries: 1, deadline,
      validate: (response) => {
        if (typeof response.data?.isLogin !== 'boolean') {
          throw transientError('Bilibili 登录状态响应不完整，请稍后重试')
        }
      }
    }, 4000)
    const data = nav.data
    if (!data?.isLogin) {
      loginStateCache = null
      logWarn('Bilibili session rejected by nav (isLogin=false); re-login required')
      return { loggedIn: false, profile: null }
    }
    // Profile enrichment is optional and runs alongside cookie maintenance so
    // their timeout budgets do not stack on the playback login-check chain.
    const [refreshed, profileDetails] = await Promise.all([
      refreshCookieIfNeeded(auth, deadline),
      fetchProfileDetails(data.mid, auth.cookie, deadline)
    ])
    const cookie = refreshed?.cookie || auth.cookie
    cacheWbiKeysFromNav(data)
    const profile = await mapProfile(data, cookie, profileDetails)
    loginStateCache = { cookie, profile, expiresAt: Date.now() + LOGIN_CHECK_CACHE_TTL_MS }
    return { loggedIn: true, profile }
  } catch (error) {
    logWarn(`Bilibili login check failed: ${errorToMessage(error)}`)
    if (error?.biliCode === -101) {
      loginStateCache = null
      return { loggedIn: false, profile: null }
    }
    if (
      error?.retryable && loginStateCache?.cookie === auth.cookie &&
      Date.now() < loginStateCache.expiresAt + LOGIN_CHECK_STALE_TTL_MS
    ) {
      return { loggedIn: true, profile: loginStateCache.profile }
    }
    // A failed network probe does not prove that the saved session expired.
    throw error
  }
}

async function getProfile() {
  const state = await checkLogin()
  return state.profile
}

async function logout() {
  await requireContext().settings.delete(SETTINGS_AUTH_KEY)
  await requireContext().settings.delete(SETTINGS_PINNED_FAVORITE_KEY)
  await requireContext().settings.delete(SETTINGS_PINNED_FAVORITES_KEY)
  proxyTokens.clear()
  favoriteTrackCache.clear()
  favoriteTrackRequests.clear()
  favoritePageCache.clear()
  favoritePageRequests.clear()
  favoriteFolderVersions.clear()
  favoriteLibraryRequests.clear()
  loginCheckRequests.clear()
  cookieRefreshCheckedAt = 0
  loginStateCache = null
  wbiKeysCache = null
}

async function getQrLogin() {
  const response = await biliJson('https://passport.bilibili.com/x/passport-login/web/qrcode/generate', { retries: 1 }, 4000)
  const data = response.data
  if (!data?.qrcode_key || !data?.url) {
    throw new Error('Bilibili 二维码生成失败')
  }
  return {
    key: String(data.qrcode_key),
    qrContent: String(data.url),
    expiresInSeconds: QR_EXPIRES_SECONDS
  }
}

async function checkQrLogin(key) {
  if (typeof key !== 'string' || !key.trim()) throw new Error('Bilibili 二维码 key 无效')
  const url = new URL('https://passport.bilibili.com/x/passport-login/web/qrcode/poll')
  url.searchParams.set('qrcode_key', key.trim())
  const { headers, json } = await fetchWithTimeout(url, { headers: defaultHeaders() }, BILI_REQUEST_TIMEOUT_MS,
    async (response) => ({ headers: response.headers, json: await response.json() }))
  const code = Number(json?.data?.code ?? json?.code)
  if (code === 0) {
    const cookies = parseSetCookies(getSetCookieHeaders(headers))
    const cookie = mergeCookieString(cookies)
    if (!cookie.includes('SESSDATA=')) throw new Error('Bilibili 登录成功但没有返回 SESSDATA')
    const refreshToken = typeof json?.data?.refresh_token === 'string' ? json.data.refresh_token : ''
    await requireContext().settings.set(SETTINGS_AUTH_KEY, {
      cookie,
      refreshToken,
      updatedAt: new Date().toISOString()
    })
    cookieRefreshCheckedAt = 0
    loginStateCache = null
    await ensureDeviceCookie({ cookie, refreshToken })
    logInfo('Bilibili login succeeded')
  }
  return { code, message: typeof json?.data?.message === 'string' ? json.data.message : '' }
}

async function fetchUserLibrary() {
  const deadline = Date.now() + FAVORITE_LOAD_TIMEOUT_MS
  const auth = await readAuth()
  if (!auth?.cookie) throw new Error('请先登录 Bilibili')
  return shareRequest(favoriteLibraryRequests, auth.cookie, () => loadUserLibrary(deadline))
}

async function loadUserLibrary(deadline) {
  const { cookie, profile } = await requireLoggedIn()
  const pinnedFavoriteFolderIds = await readPinnedFavoriteFolderIds()
  const url = new URL('https://api.bilibili.com/x/v3/fav/folder/created/list-all')
  url.searchParams.set('up_mid', String(profile.userId))
  url.searchParams.set('type', '2')
  const response = await biliJson(url, {
    cookie, retries: 1, deadline,
    validate: (response) => {
      if (!response.data || (response.data.list != null && !Array.isArray(response.data.list))) {
        throw transientError('Bilibili 收藏夹列表数据不完整，请稍后重试')
      }
    }
  })
  const list = Array.isArray(response.data?.list) ? response.data.list : []
  const playlists = await Promise.all(
    sortFavoriteFolders(list, pinnedFavoriteFolderIds).map(async (folder) => {
      const id = String(folder.id)
      return {
        id,
        name: String(folder.title || 'Bilibili 收藏夹'),
        cover:
          (typeof folder.cover === 'string' && folder.cover
            ? await createImageProxyUrl(folder.cover, cookie)
            : null),
        trackCount: Number(folder.media_count) || 0,
        pinned: pinnedFavoriteFolderIds.includes(id)
      }
    })
  )
  return {
    likedPlaylist: playlists[0] ?? null,
    playlists
  }
}

async function fetchPlaylistTracksPage(playlistId, offset = 0, limit = PAGE_SIZE, force = false) {
  const size = Math.min(PAGE_SIZE, Math.max(1, Math.floor(Number(limit) || PAGE_SIZE)))
  if (!Number.isSafeInteger(offset) || offset < 0 || offset % size !== 0) {
    throw new Error('Bilibili 收藏夹分页位置无效')
  }
  const deadline = Date.now() + FAVORITE_LOAD_TIMEOUT_MS
  const auth = await readAuth()
  if (!auth?.cookie) throw new Error('请先登录 Bilibili')
  const context = requireContext()
  const session = favoriteSessionKey(auth.cookie)
  const folderKey = JSON.stringify([session, String(playlistId)])
  const cacheKey = JSON.stringify([folderKey, offset, size])
  const version = favoriteFolderVersions.get(folderKey) || 0
  const cached = favoritePageCache.get(cacheKey)
  if (!force && cached && isCacheEntryFresh(cached, Date.now())) return cached.page
  const requestKey = force && offset === 0
    ? JSON.stringify([folderKey, 'refresh'])
    : JSON.stringify([cacheKey, version])
  return shareRequest(favoritePageRequests, requestKey, async () => {
    let pageVersion = version
    // Refresh once per shared request. Late responses from older loads must
    // not repopulate the refreshed folder with stale later pages.
    if (force && offset === 0) {
      pageVersion++
      favoriteFolderVersions.set(folderKey, pageVersion)
      for (const [key, entry] of favoritePageCache) {
        if (entry.folderKey === folderKey) favoritePageCache.delete(key)
      }
    }
    try {
      const { cookie } = await requireLoggedIn()
      const data = await fetchFavoritePage(playlistId, cookie, offset / size + 1, size, deadline)
      const medias = Array.isArray(data.medias) ? data.medias : []
      const albumName = typeof data.info?.title === 'string' ? data.info.title : 'Bilibili'
      const tracks = await mapWithConcurrency(
        medias.filter((media) => media?.type === 2 && media?.attr === 0),
        VIDEO_VIEW_CONCURRENCY,
        (media) => mapMediaToTracks(media, albumName, cookie, deadline)
      )
      const page = {
        tracks: tracks.flat().filter(Boolean),
        // media_count counts videos, not expanded playable tracks.
        total: null,
        nextOffset: offset + size,
        hasMore: Boolean(data.has_more) && medias.length > 0
      }
      if (
        pluginContext === context && favoriteSessionKey((await readAuth())?.cookie) === session &&
        (favoriteFolderVersions.get(folderKey) || 0) === pageVersion
      ) {
        favoritePageCache.delete(cacheKey)
        favoritePageCache.set(cacheKey, { folderKey, page, expiresAt: Date.now() + FAVORITE_CACHE_TTL_MS })
        while (favoritePageCache.size > MAX_FAVORITE_PAGE_CACHE_ENTRIES) {
          favoritePageCache.delete(favoritePageCache.keys().next().value)
        }
      }
      return page
    } catch (error) {
      logWarn(`Bilibili favorite folder ${playlistId} page ${offset / size + 1} failed: ${errorToMessage(error)} (code=${error?.biliCode ?? 'network'})`)
      throw error
    }
  })
}

async function fetchFavoritePage(playlistId, cookie, page, size, deadline) {
  const url = new URL('https://api.bilibili.com/x/v3/fav/resource/list')
  url.searchParams.set('media_id', String(playlistId))
  url.searchParams.set('ps', String(size))
  url.searchParams.set('pn', String(page))
  url.searchParams.set('type', '0')
  url.searchParams.set('platform', 'web')
  const response = await biliJson(url, {
    cookie, retries: 1, deadline,
    validate: (response) => {
      const data = response.data
      if (
        !data || typeof data !== 'object' ||
        (data.medias != null && !Array.isArray(data.medias)) ||
        (data.medias == null && (data.has_more || Number(data.info?.media_count) > 0))
      ) {
        throw transientError('Bilibili 收藏夹数据不完整，请稍后重试')
      }
    }
  })
  return response.data
}

async function fetchPlaylistTracks(playlistId, force = false) {
  const deadline = Date.now() + FAVORITE_LOAD_TIMEOUT_MS
  const auth = await readAuth()
  if (!auth?.cookie) throw new Error('请先登录 Bilibili')
  const context = requireContext()
  const session = favoriteSessionKey(auth.cookie)
  const cacheKey = JSON.stringify([session, String(playlistId)])
  const cached = favoriteTrackCache.get(cacheKey)
  if (!force && cached && isCacheEntryFresh(cached, Date.now())) return cached.tracks
  return shareRequest(favoriteTrackRequests, cacheKey, async () => {
    try {
      const { cookie } = await requireLoggedIn()
      const tracks = await loadFavoriteTracks(playlistId, cookie, deadline)
      if (pluginContext === context && favoriteSessionKey((await readAuth())?.cookie) === session) {
        favoriteTrackCache.set(cacheKey, { tracks, expiresAt: Date.now() + FAVORITE_CACHE_TTL_MS })
      }
      return tracks
    } catch (error) {
      if (
        error?.retryable && cached && pluginContext === context &&
        Date.now() < cached.expiresAt + FAVORITE_CACHE_STALE_TTL_MS &&
        favoriteSessionKey((await readAuth())?.cookie) === session
      ) {
        logWarn(`Bilibili favorite folder ${playlistId} refresh failed; using cached tracks: ${errorToMessage(error)}`)
        return cached.tracks
      }
      throw error
    }
  })
}

async function loadFavoriteTracks(playlistId, cookie, deadline) {
  const fetchPage = (page) => fetchFavoritePage(playlistId, cookie, page, PAGE_SIZE, deadline)
  const first = await fetchPage(1)
  const entries = []
  const appendPage = (data) => {
    const medias = Array.isArray(data.medias) ? data.medias : []
    const albumName = typeof data.info?.title === 'string' ? data.info.title : 'Bilibili'
    entries.push(...medias.filter((media) => media?.type === 2 && media?.attr === 0)
      .map((media) => ({ media, albumName })))
    return Boolean(data.has_more) && medias.length > 0
  }
  let hasMore = appendPage(first)
  const knownPageCount = Math.min(MAX_FAVORITE_PAGES, Math.ceil(Number(first.info?.media_count) / PAGE_SIZE) || 1)
  let nextPage = 2
  while (hasMore && nextPage <= MAX_FAVORITE_PAGES) {
    // Use the server's count when available; older payloads retain sequential
    // has_more pagination instead of issuing requests beyond the final page.
    const count = Math.min(FAVORITE_PAGE_CONCURRENCY, Math.max(1, knownPageCount - nextPage + 1))
    const pages = await mapWithConcurrency(
      Array.from({ length: count }, (_, index) => nextPage + index),
      FAVORITE_PAGE_CONCURRENCY, fetchPage
    )
    for (const data of pages) {
      hasMore = appendPage(data)
      if (!hasMore) break
    }
    nextPage += count
  }
  const tracks = await mapWithConcurrency(entries, VIDEO_VIEW_CONCURRENCY, ({ media, albumName }) =>
    mapMediaToTracks(media, albumName, cookie, deadline)
  )
  return tracks.flat().filter(Boolean)
}

function favoriteSessionKey(cookie) {
  return cookie ? JSON.stringify([extractCookieValue(cookie, 'DedeUserID'), extractCookieValue(cookie, 'SESSDATA')]) : null
}

async function shareRequest(requests, key, load) {
  if (requests.has(key)) return requests.get(key)
  const pending = load()
  requests.set(key, pending)
  try {
    return await pending
  } finally {
    if (requests.get(key) === pending) requests.delete(key)
  }
}

async function searchSongs(keywords, limit = SEARCH_DEFAULT_LIMIT, offset = 0) {
  const keyword = String(keywords || '').trim()
  if (!keyword) return { items: [], total: 0 }
  const { cookie } = await requireLoggedIn()
  const keys = await getWbiKeys(cookie)
  const limitNumber = Math.max(1, Number(limit) || SEARCH_DEFAULT_LIMIT)
  const offsetNumber = Math.max(0, Number(offset) || 0)
  const page = Math.floor(offsetNumber / SEARCH_PAGE_SIZE) + 1
  const query = encodeWbiWithKeys(
    {
      keyword,
      search_type: 'video',
      page,
      page_size: SEARCH_PAGE_SIZE,
      order: '',
      duration: 0,
      tids: 0
    },
    keys
  )
  const url = `https://api.bilibili.com/x/web-interface/wbi/search/type?${query}`
  const response = await biliJson(url, { cookie })
  const results = Array.isArray(response.data?.result) ? response.data.result : []
  const total = Number(response.data?.pageInfo?.total ?? results.length)
  const items = await mapWithConcurrency(results.slice(0, limitNumber), SEARCH_VIEW_CONCURRENCY, (item) =>
    mapSearchResultToTrack(item, cookie)
  )
  return { items: items.filter(Boolean), total }
}

async function getPlaybackUrl(track) {
  const startedAt = Date.now()
  const deadline = startedAt + PLAYBACK_LOAD_TIMEOUT_MS
  const { cookie } = await requireLoggedIn()
  const ids = parseBiliTrackId(track?.id || track?.filePath)
  if (!ids) throw new Error('Bilibili track id 无效')
  const keys = await getWbiKeys(cookie, deadline)
  logInfo(`Bilibili getPlaybackUrl: ${ids.bvid}:${ids.cid}`)

  // Prefer DASH: a dedicated audio stream with backup CDN URLs. The
  // progressive endpoint (qn=16, fnval=0) only yields a 360p muxed A/V stream
  // and is regularly routed to unstable P2P edge nodes that stall the proxy.
  let refreshedCid = null
  try {
    const audioSource = await fetchDashAudioSource(ids, cookie, keys, deadline)
    if (audioSource) return await createStreamUrl(audioSource, ids, cookie, startedAt)
  } catch (error) {
    logWarn(`Bilibili DASH unavailable for ${ids.bvid}:${ids.cid}: ${errorToMessage(error)}`)
    // A stale cid from a cached library listing yields playurl -404; re-resolve
    // the cid from the live view API once before giving up.
    refreshedCid = await refreshCidFromView(ids, cookie, deadline)
    if (refreshedCid) {
      try {
        const audioSource = await fetchDashAudioSource(
          { bvid: ids.bvid, cid: refreshedCid },
          cookie,
          keys,
          deadline
        )
        if (audioSource) {
          return await createStreamUrl(audioSource, { bvid: ids.bvid, cid: refreshedCid }, cookie, startedAt)
        }
      } catch (retryError) {
        logWarn(`Bilibili DASH retry with refreshed cid failed: ${errorToMessage(retryError)}`)
        if (isTrackMissingError(retryError)) {
          throw new Error(`Bilibili 视频已失效或不可播放：${ids.bvid}`)
        }
      }
    } else if (isTrackMissingError(error)) {
      throw new Error(`Bilibili 视频已失效或不可播放：${ids.bvid}`)
    }
  }

  const effectiveIds = refreshedCid ? { bvid: ids.bvid, cid: refreshedCid } : ids
  const progressiveQuery = encodeWbiWithKeys(
    {
      bvid: effectiveIds.bvid,
      cid: effectiveIds.cid,
      qn: 16,
      fnval: 0,
      fnver: 0,
      fourk: 0,
      platform: 'html5'
    },
    keys
  )
  const progressiveUrl = `https://api.bilibili.com/x/player/wbi/playurl?${progressiveQuery}`
  const progressiveResponse = await biliJson(progressiveUrl, { cookie, deadline }, PLAYURL_TIMEOUT_MS)
  const progressiveMediaUrl = selectProgressivePlaybackUrl(progressiveResponse.data)
  if (!progressiveMediaUrl) throw new Error(`Bilibili 未返回可播放音频流：${ids.bvid}`)
  await ensureProxyServer()
  const token = createProxyToken(
    { kind: 'stream', url: progressiveMediaUrl, cookie },
    STREAM_PROXY_TOKEN_TTL_MS
  )
  logInfo(
    `Bilibili progressive fallback selected for ${ids.bvid}:${effectiveIds.cid} in ${Date.now() - startedAt}ms`
  )
  return `http://127.0.0.1:${proxyPort}/stream/${token}`
}

async function fetchDashAudioSource(ids, cookie, keys, deadline) {
  const dashQuery = encodeWbiWithKeys(
    {
      bvid: ids.bvid,
      cid: ids.cid,
      fnval: 4048,
      fnver: 0,
      fourk: 1
    },
    keys
  )
  const playUrl = `https://api.bilibili.com/x/player/wbi/playurl?${dashQuery}`
  const response = await biliJson(playUrl, { cookie, deadline }, PLAYURL_TIMEOUT_MS)
  return selectDashAudioSource(response.data)
}

async function createStreamUrl(audioSource, ids, cookie, startedAt) {
  await ensureProxyServer()
  const token = createProxyToken(
    {
      kind: 'stream',
      urls: audioSource.urls,
      cookie,
      contentType: audioSource.contentType
    },
    STREAM_PROXY_TOKEN_TTL_MS
  )
  logInfo(
    `Bilibili playback stream selected: ${audioSource.contentType} (${audioSource.codec || 'unknown'}) for ${ids.bvid}:${ids.cid} in ${Date.now() - startedAt}ms`
  )
  return `http://127.0.0.1:${proxyPort}/stream/${token}`
}

async function refreshCidFromView(ids, cookie, deadline) {
  try {
    const view = await getVideoView(ids.bvid, cookie, { deadline }, 3000)
    const pages = Array.isArray(view?.pages) ? view.pages : []
    const cid = Number(pages[0]?.cid ?? view?.cid)
    if (Number.isFinite(cid) && cid > 0 && cid !== Number(ids.cid)) return cid
    return null
  } catch (error) {
    logWarn(`Bilibili cid refresh failed for ${ids.bvid}: ${errorToMessage(error)}`)
    return null
  }
}

export function isTrackMissingError(error) {
  const message = error instanceof Error ? error.message : String(error || '')
  return /啥都木有|-404|62002|62004|62012/.test(message)
}

async function mapMediaToTracks(media, albumName, cookie, deadline) {
  const bvid = typeof media.bvid === 'string' ? media.bvid : typeof media.bv_id === 'string' ? media.bv_id : ''
  if (!bvid) return []
  const directCid = extractMediaCid(media)
  const view = directCid ? null : await getVideoView(bvid, cookie, { deadline, retries: 1 }).catch((error) => {
    if (!isTrackMissingError(error)) throw error
    logWarn(`Skipping Bilibili media ${bvid}: ${errorToMessage(error)}`)
    return null
  })
  const pages = Array.isArray(view?.pages) ? view.pages : []
  if (pages.length > 1) {
    const coverProxy = typeof media.cover === 'string' && media.cover
      ? await createImageProxyUrl(media.cover, cookie)
      : null
    return pages
      .map((page) => {
        const track = mapPageToTrack(media, { bvid, page, albumName })
        if (track && coverProxy) track.cover = coverProxy
        return track
      })
      .filter(Boolean)
  }
  const page = pages[0] ?? null
  const cid = directCid ?? Number(page?.cid ?? view?.cid)
  if (!Number.isFinite(cid) || cid <= 0) return []
  const track = mapBiliMediaToTrack(media, {
    bvid,
    cid,
    title: typeof page?.part === 'string' && page.part.trim() ? `${media.title} - ${page.part}` : String(media.title),
    duration: Number(page?.duration ?? media.duration) || 0,
    albumName
  })
  if (track.cover) {
    track.cover = await createImageProxyUrl(track.cover, cookie)
  }
  return [track]
}

export function mapPageToTrack(media, options) {
  const bvid = options.bvid || (typeof media.bvid === 'string' ? media.bvid : '')
  const cid = Number(options.page?.cid)
  if (!Number.isFinite(cid) || cid <= 0) return null
  const partName = typeof options.page?.part === 'string' && options.page.part.trim()
    ? options.page.part
    : `P${Number(options.page?.page) || 1}`
  const baseTitle = String(media.title || 'Bilibili 视频')
  return mapBiliMediaToTrack(media, {
    bvid,
    cid,
    title: `${baseTitle} - ${partName}`,
    duration: Number(options.page?.duration) || Number(media.duration) || 0,
    albumName: options.albumName
  })
}

async function mapSearchResultToTrack(item, cookie) {
  const bvid = typeof item.bvid === 'string' ? item.bvid : ''
  if (!bvid) return null
  const view = await getVideoView(bvid, cookie).catch((error) => {
    logWarn(`Skipping Bilibili search result ${bvid}: ${errorToMessage(error)}`)
    return null
  })
  const page = Array.isArray(view?.pages) ? view.pages[0] : null
  const cid = Number(page?.cid ?? view?.cid)
  if (!Number.isFinite(cid) || cid <= 0) return null
  const title = stripHtml(item.title)
  const durationSeconds = parseDurationToSeconds(item.duration)
  const track = mapBiliMediaToTrack(
    {
      title,
      cover: item.pic,
      duration: durationSeconds,
      upper: { name: item.author || item.upman }
    },
    {
      bvid,
      cid,
      title: typeof page?.part === 'string' && page.part.trim() ? `${title} - ${page.part}` : title,
      duration: Number(page?.duration) || durationSeconds || 0,
      albumName: 'Bilibili 搜索'
    }
  )
  if (track.cover) {
    track.cover = await createImageProxyUrl(track.cover, cookie)
  }
  return track
}

async function getVideoView(bvid, cookie, options = {}, timeoutMs = BILI_REQUEST_TIMEOUT_MS) {
  const url = new URL('https://api.bilibili.com/x/web-interface/view')
  url.searchParams.set('bvid', bvid)
  const response = await biliJson(url, { cookie, ...options }, timeoutMs)
  return response.data
}

async function getWbiKeys(cookie, deadline) {
  if (wbiKeysCache && Date.now() < wbiKeysCache.expiresAt) return wbiKeysCache.keys
  const nav = await biliJson('https://api.bilibili.com/x/web-interface/nav', { cookie, deadline })
  cacheWbiKeysFromNav(nav.data)
  if (!wbiKeysCache) throw new Error('Bilibili WBI key 不可用')
  return wbiKeysCache.keys
}

function cacheWbiKeysFromNav(data) {
  try {
    const keys = extractWbiKeys(data?.wbi_img)
    wbiKeysCache = { keys, expiresAt: Date.now() + WBI_KEYS_CACHE_TTL_MS }
  } catch {
    // A nav payload without wbi_img leaves any previous key cache untouched.
  }
}

export function extractMediaCid(media) {
  const cid = Number(media?.ugc?.first_cid ?? media?.first_cid ?? media?.cid)
  return Number.isFinite(cid) && cid > 0 ? cid : null
}

export async function biliJson(input, options = {}, timeoutMs = BILI_REQUEST_TIMEOUT_MS) {
  for (let attempt = 0; ; attempt++) {
    const remaining = options.deadline == null ? timeoutMs : Math.min(timeoutMs, options.deadline - Date.now())
    if (remaining <= 0) throw transientError('Bilibili 加载超时，请稍后重试')
    try {
      return await fetchWithTimeout(input, { headers: defaultHeaders(options.cookie) }, remaining, async (response) => {
        if (!response.ok) {
          const error = new Error(`Bilibili 请求失败：HTTP ${response.status}`)
          error.retryable = [408, 429].includes(response.status) || response.status >= 500
          const retryAfter = response.headers.get('retry-after')
          if (retryAfter) {
            const delay = /^\d+(?:\.\d+)?$/.test(retryAfter)
              ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - Date.now()
            if (Number.isFinite(delay)) error.retryAfterMs = Math.max(0, delay)
          }
          await response.body?.cancel()
          throw error
        }
        const json = await response.json()
        if (typeof json?.code !== 'number') throw transientError('Bilibili 返回数据不完整，请稍后重试')
        if (json?.code !== 0) {
          const error = new Error(`Bilibili API 错误：${json?.message || '请求被拒绝'}（${json.code}）`)
          error.biliCode = json?.code
          throw error
        }
        options.validate?.(json)
        return json
      })
    } catch (error) {
      if (error instanceof TypeError || error instanceof SyntaxError) error.retryable = true
      if (!error?.retryable || attempt >= (options.retries || 0)) throw error
      const delay = Math.max(300, error.retryAfterMs || 0)
      // Long rate-limit waits belong to a later user retry, not this RPC.
      if (delay > 5000 || (options.deadline != null && options.deadline - Date.now() <= delay)) throw error
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }
}

function transientError(message) {
  const error = new Error(message)
  error.retryable = true
  return error
}

async function fetchWithTimeout(input, options = {}, timeoutMs = BILI_REQUEST_TIMEOUT_MS, consume = (response) => response) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(input, {
      ...options,
      signal: controller.signal
    })
    // JSON body reads must remain inside the timeout, not just response headers.
    return await consume(response)
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw transientError('Bilibili 请求超时，请稍后重试')
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}

async function refreshCookieIfNeeded(auth, deadline) {
  if (Date.now() - cookieRefreshCheckedAt < COOKIE_REFRESH_CHECK_INTERVAL_MS) return null
  cookieRefreshCheckedAt = Date.now()
  const biliJct = extractCookieValue(auth.cookie, 'bili_jct')
  if (!biliJct || !auth.refreshToken) return null
  try {
    const infoUrl = new URL('https://passport.bilibili.com/x/passport-login/web/cookie/info')
    infoUrl.searchParams.set('csrf', biliJct)
    const info = await biliJson(infoUrl, { cookie: auth.cookie, deadline }, COOKIE_REFRESH_TIMEOUT_MS)
    if (!info?.data?.refresh) return null
    const refreshCsrf = typeof info.data.refresh_csrf === 'string' ? info.data.refresh_csrf : ''
    if (!refreshCsrf) {
      logWarn('Bilibili cookie refresh requested but refresh_csrf missing')
      return null
    }
    const refreshUrl = new URL('https://passport.bilibili.com/x/passport-login/web/cookie/refresh')
    refreshUrl.searchParams.set('csrf', biliJct)
    refreshUrl.searchParams.set('refresh_csrf', refreshCsrf)
    refreshUrl.searchParams.set('source', 'main_web')
    const remaining = Math.min(COOKIE_REFRESH_TIMEOUT_MS, deadline - Date.now())
    if (remaining <= 0) return null
    const refreshResponse = await fetchWithTimeout(
      refreshUrl,
      { headers: defaultHeaders(auth.cookie) },
      remaining,
      async (response) => ({ headers: response.headers, json: await response.json() })
    )
    const refreshJson = refreshResponse.json
    if (refreshJson?.code !== 0) {
      logWarn(`Bilibili cookie refresh rejected: ${refreshJson?.message || refreshJson?.code}`)
      return null
    }
    const setCookies = parseSetCookies(getSetCookieHeaders(refreshResponse.headers))
    const mergedCookie = mergeRefreshedCookies(auth.cookie, setCookies)
    if (!mergedCookie.includes('SESSDATA=')) {
      logWarn('Bilibili cookie refresh succeeded but SESSDATA missing')
      return null
    }
    const nextRefreshToken =
      typeof refreshJson?.data?.refresh_token === 'string' ? refreshJson.data.refresh_token : auth.refreshToken
    await requireContext().settings.set(SETTINGS_AUTH_KEY, {
      cookie: mergedCookie,
      refreshToken: nextRefreshToken,
      updatedAt: new Date().toISOString()
    })
    logInfo('Bilibili cookie refreshed silently')
    return { cookie: mergedCookie, refreshToken: nextRefreshToken }
  } catch (error) {
    logWarn(`Bilibili cookie refresh skipped: ${errorToMessage(error)}`)
    return null
  }
}

async function setPinnedFavoriteFolder(playlist) {
  const currentIds = await readPinnedFavoriteFolderIds()
  if (arguments.length === 0) return { pinnedFavoriteFolderIds: currentIds }
  const nextId = normalizeFavoriteFolderId(playlist)
  if (!nextId) {
    await clearPinnedFavoriteFolders()
    return { pinnedFavoriteFolderIds: [] }
  }
  const nextIds = currentIds.includes(nextId)
    ? currentIds.filter((id) => id !== nextId)
    : [...currentIds, nextId]
  await writePinnedFavoriteFolderIds(nextIds)
  return { pinnedFavoriteFolderIds: nextIds }
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length)
  let nextIndex = 0
  let failed = false
  let failure
  const workerCount = Math.min(Math.max(1, concurrency), items.length)
  const workers = Array.from({ length: workerCount }, async () => {
    while (!failed && nextIndex < items.length) {
      const index = nextIndex
      nextIndex += 1
      try {
        results[index] = await mapper(items[index], index)
      } catch (error) {
        if (!failed) failure = error
        failed = true
      }
    }
  })
  await Promise.all(workers)
  if (failed) throw failure
  return results
}

function defaultHeaders(cookie) {
  const headers = {
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    Referer: BILI_REFERER,
    'User-Agent': BILI_UA
  }
  if (cookie) headers.Cookie = cookie
  return headers
}

async function requireLoggedIn() {
  const auth = await readAuth()
  if (!auth?.cookie) throw new Error('请先登录 Bilibili')
  const cookie = await ensureDeviceCookie(auth)
  const login = await checkLogin()
  if (!login.loggedIn || !login.profile) throw new Error('Bilibili 登录已失效，请重新登录')
  const refreshedAuth = await readAuth()
  return { cookie: refreshedAuth?.cookie || cookie, profile: login.profile }
}

/**
 * Attach the anonymous device cookie (buvid3/buvid4) that the bilibili web
 * client always sends. Logged-in API calls without it are subject to slower
 * risk-controlled handling and degraded playurl responses.
 */
async function ensureDeviceCookie(auth) {
  if (extractCookieValue(auth.cookie, 'buvid3')) return auth.cookie
  try {
    const spi = await biliJson('https://api.bilibili.com/x/frontend/finger/spi', {}, DEVICE_COOKIE_TIMEOUT_MS)
    const buvid3 = String(spi.data?.b_3 || '')
    if (!buvid3) return auth.cookie
    const merged = mergeRefreshedCookies(auth.cookie, {
      buvid3,
      buvid4: String(spi.data?.b_4 || '')
    })
    await requireContext().settings.set(SETTINGS_AUTH_KEY, {
      cookie: merged,
      refreshToken: auth.refreshToken,
      updatedAt: new Date().toISOString()
    })
    logInfo('Bilibili device cookie (buvid3) attached')
    return merged
  } catch (error) {
    logWarn(`Bilibili device cookie fetch skipped: ${errorToMessage(error)}`)
    return auth.cookie
  }
}

async function readAuth() {
  const value = await requireContext().settings.get(SETTINGS_AUTH_KEY)
  if (!value || typeof value !== 'object') return null
  const cookie = typeof value.cookie === 'string' ? value.cookie : ''
  if (!cookie) return null
  return {
    cookie,
    refreshToken: typeof value.refreshToken === 'string' ? value.refreshToken : ''
  }
}

async function ensureProxyServer() {
  if (proxyServer && proxyPort > 0) return
  // Concurrent getPlaybackUrl calls must not race two servers into existence.
  if (!proxyServerStart) {
    proxyServerStart = startProxyServer().finally(() => {
      proxyServerStart = null
    })
  }
  await proxyServerStart
}

async function startProxyServer() {
  const server = createServer((request, response) => {
    void handleProxyRequest(request, response)
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      proxyPort = typeof address === 'object' && address ? address.port : 0
      server.off('error', reject)
      resolve()
    })
  })
  proxyServer = server
}

async function handleProxyRequest(request, response) {
  // Players abort connections constantly (FFmpeg seeks, track switches). Tie
  // the upstream fetch to the client socket so aborted requests stop pulling
  // from the CDN instead of leaking zombie streams.
  const upstreamAbort = new AbortController()
  const abortUpstream = () => upstreamAbort.abort()
  request.on('error', abortUpstream)
  response.on('close', abortUpstream)
  try {
    response.setHeader('Access-Control-Allow-Origin', '*')
    if (request.method === 'OPTIONS') {
      response.statusCode = 204
      response.end()
      return
    }
    const match = /^\/(stream|image)\/([a-f0-9]+)$/.exec(request.url || '')
    const kind = match?.[1]
    const entry = match ? proxyTokens.get(match[2]) : null
    if (!entry || entry.kind !== kind || entry.expiresAt <= Date.now()) {
      response.statusCode = 403
      response.end('Invalid or expired stream token')
      return
    }
    const upstreamHeaders = {
      Referer: BILI_REFERER,
      'User-Agent': BILI_UA
    }
    if (entry.cookie) upstreamHeaders.Cookie = entry.cookie
    const range = request.headers.range
    if (kind === 'stream' && typeof range === 'string') upstreamHeaders.Range = range
    const upstream =
      kind === 'stream'
        ? await fetchStreamCandidate(entry, upstreamHeaders, upstreamAbort.signal)
        : await fetch(entry.url, { headers: upstreamHeaders, signal: upstreamAbort.signal })
    if (!upstream) {
      response.statusCode = 502
      response.end('Bilibili proxy failed: no playable upstream stream')
      return
    }
    response.statusCode = upstream.status
    for (const [name, value] of upstream.headers) {
      if (shouldProxyHeader(name)) response.setHeader(name, value)
    }
    response.setHeader('Access-Control-Allow-Origin', '*')
    if (kind === 'stream') {
      response.setHeader('Content-Type', entry.contentType || upstream.headers.get('content-type') || 'audio/mp4')
    }
    if (kind === 'image') {
      response.setHeader('Cache-Control', 'private, max-age=21600')
    }
    if (request.method === 'HEAD') {
      response.end()
      return
    }
    if (!upstream.body) {
      response.end()
      return
    }
    // pipeline applies backpressure and forwards stream errors; a bare
    // for-await write loop would buffer the whole song in memory once the
    // client stops reading.
    await pipeline(Readable.fromWeb(upstream.body), response)
  } catch (error) {
    if (response.headersSent) {
      response.destroy()
      return
    }
    response.statusCode = 502
    response.end(`Bilibili proxy failed: ${errorToMessage(error)}`)
  }
}

function createProxyToken(entry, ttlMs) {
  const token = randomBytes(16).toString('hex')
  proxyTokens.set(token, {
    ...entry,
    expiresAt: Date.now() + ttlMs
  })
  for (const [key, value] of proxyTokens) {
    if (value.expiresAt <= Date.now()) proxyTokens.delete(key)
  }
  return token
}

async function createImageProxyUrl(url, cookie) {
  const normalized = normalizeImageUrl(url)
  if (!normalized) return null
  await ensureProxyServer()
  const token = createProxyToken(
    {
      kind: 'image',
      url: normalized,
      cookie
    },
    IMAGE_PROXY_TOKEN_TTL_MS
  )
  return `http://127.0.0.1:${proxyPort}/image/${token}`
}

export async function fetchStreamCandidate(entry, upstreamHeaders, signal, timeoutMs = STREAM_CANDIDATE_TIMEOUT_MS) {
  const urls = Array.isArray(entry.urls) ? entry.urls : entry.url ? [entry.url] : []
  let lastError = null
  for (const url of urls) {
    // The timeout only guards header arrival: once a CDN answers we must not
    // cut off the body mid-song. A dead edge node then falls through to the
    // next backup URL instead of stalling the player forever.
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const onClientAbort = () => controller.abort()
    signal?.addEventListener('abort', onClientAbort)
    try {
      const upstream = await fetch(url, { headers: upstreamHeaders, signal: controller.signal })
      if (upstream.ok) return upstream
      lastError = new Error(`HTTP ${upstream.status}`)
      logWarn(`Bilibili stream candidate failed: ${upstream.status}`)
    } catch (error) {
      if (signal?.aborted) return null
      lastError = error
      logWarn(`Bilibili stream candidate failed: ${errorToMessage(error)}`)
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onClientAbort)
    }
  }
  if (lastError) logWarn(`Bilibili stream exhausted: ${errorToMessage(lastError)}`)
  return null
}

function shouldProxyHeader(name) {
  return ![
    'connection',
    'content-encoding',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'transfer-encoding',
    'upgrade'
  ].includes(name.toLowerCase())
}

function getSetCookieHeaders(headers) {
  if (typeof headers.getSetCookie === 'function') return headers.getSetCookie()
  const raw = headers.get('set-cookie')
  return raw ? splitSetCookie(raw) : []
}

export function parseSetCookies(setCookieHeaders) {
  const cookies = {}
  for (const header of setCookieHeaders) {
    const first = String(header).split(';')[0]
    const separatorIndex = first.indexOf('=')
    if (separatorIndex <= 0) continue
    const name = first.slice(0, separatorIndex).trim()
    const value = first.slice(separatorIndex + 1).trim()
    if (['SESSDATA', 'bili_jct', 'DedeUserID', 'DedeUserID__ckMd5', 'sid'].includes(name)) {
      cookies[name] = value
    }
  }
  return cookies
}

function splitSetCookie(raw) {
  return String(raw).split(/,(?=\s*[^;,=\s]+=[^;,]+)/g).map((item) => item.trim())
}

function mergeCookieString(cookies) {
  return Object.entries(cookies)
    .filter(([, value]) => value)
    .map(([name, value]) => `${name}=${value}`)
    .join('; ')
}

export function extractCookieValue(cookie, name) {
  if (typeof cookie !== 'string' || !cookie || typeof name !== 'string' || !name) return ''
  const target = `${name}=`
  for (const part of cookie.split(';')) {
    const trimmed = part.trim()
    if (trimmed.startsWith(target)) return trimmed.slice(target.length)
  }
  return ''
}

export function mergeRefreshedCookies(oldCookie, setCookieMap) {
  const map = parseCookieStringToMap(oldCookie)
  for (const [name, value] of Object.entries(setCookieMap || {})) {
    if (name && value) map[name] = value
  }
  return Object.entries(map)
    .filter(([, value]) => value)
    .map(([name, value]) => `${name}=${value}`)
    .join('; ')
}

function parseCookieStringToMap(cookie) {
  const map = {}
  if (typeof cookie !== 'string') return map
  for (const part of cookie.split(';')) {
    const trimmed = part.trim()
    if (!trimmed) continue
    const idx = trimmed.indexOf('=')
    if (idx <= 0) continue
    const name = trimmed.slice(0, idx).trim()
    const value = trimmed.slice(idx + 1).trim()
    if (name) map[name] = value
  }
  return map
}

export function isCacheEntryFresh(entry, now = Date.now()) {
  if (!entry || typeof entry !== 'object') return false
  if (typeof entry.expiresAt !== 'number') return false
  return entry.expiresAt > now
}

export function stripHtml(value) {
  return String(value ?? '').replace(/<[^>]*>/g, '')
}

export function parseDurationToSeconds(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string' || !value) return 0
  const parts = value.split(':').map((part) => Number(part) || 0)
  if (parts.length === 1) return parts[0]
  if (parts.length === 2) return parts[0] * 60 + parts[1]
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
  return 0
}

export function sortFavoriteFolders(list, pinnedFavoriteFolderIds = []) {
  return sortFavoriteFoldersWithPinned(list, pinnedFavoriteFolderIds)
}

export function sortFavoriteFoldersWithPinned(list, pinnedFavoriteFolderIds = []) {
  const pinnedIds = normalizeFavoriteFolderIds(pinnedFavoriteFolderIds)
  return [...list].sort((left, right) => {
    const leftPinned = pinnedIds.includes(String(left?.id)) ? 0 : 1
    const rightPinned = pinnedIds.includes(String(right?.id)) ? 0 : 1
    if (leftPinned !== rightPinned) return leftPinned - rightPinned
    const leftDefault = isDefaultFavorite(left) ? 0 : 1
    const rightDefault = isDefaultFavorite(right) ? 0 : 1
    if (leftDefault !== rightDefault) return leftDefault - rightDefault
    return String(left.title || '').localeCompare(String(right.title || ''), 'zh-CN')
  })
}

function isDefaultFavorite(folder) {
  const attr = Number(folder?.attr)
  return Number.isFinite(attr) && (attr & 0b10) === 0
}

async function readPinnedFavoriteFolderIds() {
  const settings = requireContext().settings
  const ids = normalizeFavoriteFolderIds(await settings.get(SETTINGS_PINNED_FAVORITES_KEY))
  if (ids.length > 0) return ids
  const legacyId = normalizeFavoriteFolderId(await settings.get(SETTINGS_PINNED_FAVORITE_KEY))
  if (!legacyId) return []
  await settings.set(SETTINGS_PINNED_FAVORITES_KEY, [legacyId])
  await settings.delete(SETTINGS_PINNED_FAVORITE_KEY)
  return [legacyId]
}

async function writePinnedFavoriteFolderIds(ids) {
  const normalized = normalizeFavoriteFolderIds(ids)
  if (normalized.length === 0) {
    await clearPinnedFavoriteFolders()
    return
  }
  await requireContext().settings.set(SETTINGS_PINNED_FAVORITES_KEY, normalized)
  await requireContext().settings.delete(SETTINGS_PINNED_FAVORITE_KEY)
}

async function clearPinnedFavoriteFolders() {
  await requireContext().settings.delete(SETTINGS_PINNED_FAVORITES_KEY)
  await requireContext().settings.delete(SETTINGS_PINNED_FAVORITE_KEY)
}

function normalizeFavoriteFolderId(value) {
  if (value && typeof value === 'object') return normalizeFavoriteFolderId(value.id)
  if (typeof value !== 'string' && typeof value !== 'number') return ''
  const id = String(value).trim()
  return /^\d+$/.test(id) ? id : ''
}

function normalizeFavoriteFolderIds(value) {
  const rawValues = Array.isArray(value) ? value : [value]
  return [...new Set(rawValues.map(normalizeFavoriteFolderId).filter(Boolean))]
}

export function mapBiliMediaToTrack(media, options) {
  const title = String(options.title || media.title || 'Bilibili 视频')
  const artist = String(media.upper?.name || 'Bilibili')
  const id = `bili:${options.bvid}:${options.cid}`
  return {
    id,
    title,
    artist,
    album: String(options.albumName || 'Bilibili'),
    filePath: id,
    fileName: `${artist} - ${title}`,
    duration: Number(options.duration) || Number(media.duration) || 0,
    size: 0,
    cover: typeof media.cover === 'string' && media.cover ? normalizeImageUrl(media.cover) : null,
    lyrics: null,
    source: PROVIDER_ID
  }
}

async function fetchProfileDetails(userId, cookie, deadline) {
  try {
    const response = await biliJson(
      'https://api.bilibili.com/x/space/myinfo',
      { cookie, deadline },
      PROFILE_REQUEST_TIMEOUT_MS
    )
    if (String(response.data?.mid) !== String(userId)) return null
    return response.data
  } catch (error) {
    logWarn(`Bilibili profile details unavailable: ${errorToMessage(error)}`)
    return null
  }
}

async function mapProfile(data, cookie, profileDetails) {
  return {
    userId: data.mid,
    nickname: String(data.uname || 'Bilibili 用户'),
    avatarUrl: (await createImageProxyUrl(String(data.face || ''), cookie)) || '',
    signature: typeof profileDetails?.sign === 'string' ? profileDetails.sign : '',
    follows: 0,
    followeds: 0
  }
}

function normalizeImageUrl(url) {
  if (!url) return ''
  if (url.startsWith('//')) return `https:${url}`
  if (url.startsWith('http://')) return `https://${url.slice('http://'.length)}`
  return url
}

function parseBiliTrackId(value) {
  if (typeof value !== 'string') return null
  const match = /^bili:([^:]+):(\d+)$/.exec(value)
  if (!match) return null
  return { bvid: match[1], cid: match[2] }
}

function extractWbiKeys(wbiImg) {
  const imgKey = extractWbiKey(wbiImg?.img_url)
  const subKey = extractWbiKey(wbiImg?.sub_url)
  if (!imgKey || !subKey) throw new Error('Bilibili WBI key 不可用')
  return { imgKey, subKey }
}

function extractWbiKey(url) {
  if (typeof url !== 'string') return ''
  const name = url.split('/').pop() || ''
  return name.split('.')[0] || ''
}

export function encodeWbiWithKeys(params, keys, timestamp = Math.floor(Date.now() / 1000)) {
  const mixinKey = getMixinKey(keys.imgKey + keys.subKey)
  const signedParams = { ...params, wts: timestamp }
  const query = Object.keys(signedParams)
    .sort()
    .map((key) => `${encodeURIComponent(key)}=${encodeWbiValue(signedParams[key])}`)
    .join('&')
  const wRid = createHash('md5').update(query + mixinKey).digest('hex')
  return `${query}&w_rid=${wRid}`
}

function getMixinKey(rawKey) {
  return WBI_MIXIN_KEY_ENC_TAB.map((index) => rawKey[index]).join('').slice(0, 32)
}

function encodeWbiValue(value) {
  return encodeURIComponent(String(value).replace(/[!'()*]/g, ''))
}

export function selectDashAudioUrl(data) {
  return selectDashAudioSource(data)?.urls[0] ?? null
}

export function selectDashAudioSource(data) {
  const audio = Array.isArray(data?.dash?.audio) ? data.dash.audio : []
  // Hi-Res members get their FLAC stream in a separate dash.flac.audio field;
  // it must compete in the same ranking or it would never be selected.
  const flac = data?.dash?.flac?.audio
  const flacEntry = flac
    ? {
        ...flac,
        codecs: typeof flac.codecs === 'string' && flac.codecs ? flac.codecs : 'fLaC',
        mimeType:
          typeof flac.mimeType === 'string' && flac.mimeType
            ? flac.mimeType
            : typeof flac.mime_type === 'string' && flac.mime_type
              ? flac.mime_type
              : 'audio/flac'
      }
    : null
  const candidates = [...audio, flacEntry]
    .filter(Boolean)
    .map((item) => {
      const url = item?.baseUrl || item?.base_url
      if (typeof url !== 'string' || !url) return null
      const backups = []
      const backupList = item?.backupUrl || item?.backup_url
      if (Array.isArray(backupList)) {
        for (const backup of backupList) {
          if (typeof backup === 'string' && backup && backup !== url) backups.push(backup)
        }
      }
      const codec = typeof item?.codecs === 'string' ? item.codecs : ''
      const mimeType = typeof item?.mimeType === 'string' ? item.mimeType : typeof item?.mime_type === 'string' ? item.mime_type : 'audio/mp4'
      return {
        url,
        urls: [url, ...backups],
        bandwidth: Number(item?.bandwidth) || 0,
        codec,
        mimeType
      }
    })
    .filter(Boolean)
  candidates.sort((left, right) => {
    const leftScore = getAudioCodecScore(left.codec)
    const rightScore = getAudioCodecScore(right.codec)
    if (leftScore !== rightScore) return leftScore - rightScore
    return right.bandwidth - left.bandwidth
  })
  const selected = candidates[0] ?? null
  if (!selected) {
    return null
  }
  return {
    ...selected,
    contentType: normalizeAudioContentType(selected.mimeType, selected.codec)
  }
}

function getAudioCodecScore(codec) {
  const value = String(codec || '').toLowerCase()
  if (value.includes('flac')) return 0
  if (value.includes('mp4a') || value.includes('aac')) return 1
  if (value.includes('opus')) return 2
  return 3
}

function normalizeAudioContentType(mimeType, codec) {
  const normalized = String(mimeType || '').trim().toLowerCase()
  if (normalized.startsWith('audio/')) return normalized
  const codecText = String(codec || '').toLowerCase()
  if (codecText.includes('flac')) return 'audio/flac'
  return 'audio/mp4'
}

export function selectProgressivePlaybackUrl(data) {
  const durl = Array.isArray(data?.durl) ? data.durl : []
  const candidates = durl
    .map((item) => ({
      url: typeof item?.url === 'string' ? item.url : '',
      length: Number(item?.length) || 0,
      size: Number(item?.size) || 0
    }))
    .filter((item) => item.url)
  candidates.sort((left, right) => {
    if (left.length !== right.length) return right.length - left.length
    return left.size - right.size
  })
  return candidates[0]?.url ?? null
}

function requireContext() {
  if (!pluginContext) throw new Error('Bilibili plugin is not active')
  return pluginContext
}

function logInfo(message) {
  pluginContext?.logger.info(message)
}

function logWarn(message) {
  pluginContext?.logger.warn(message)
}

function errorToMessage(error) {
  return error instanceof Error ? error.message : String(error)
}
