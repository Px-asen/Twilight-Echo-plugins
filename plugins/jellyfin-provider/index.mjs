import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const PAGE_SIZE = 250
const PAGE_CONCURRENCY = 8
const LIST_CACHE_TTL_MS = 10 * 60 * 1000
const CACHE_FILE = 'list-cache.json'

export async function activate(context) {
  let session = await context.settings.get('session')
  let revision = 0
  const listCache = new Map()
  // 插件宿主空闲 5 分钟会被宿主回收，内存缓存随之消失；整库 3569 首的
  // 映射结果写到插件数据目录，重启/唤醒后仍可命中，避免每次进库重拉。
  const cachePath = context.storagePath ? join(context.storagePath, CACHE_FILE) : null
  let persistQueue = Promise.resolve()
  let hydrated = false

  function cacheKeyFor(active, suffix) {
    return `${active.serverUrl}|${active.userId}|${suffix}`
  }

  async function hydrateCache() {
    if (hydrated || !cachePath) return
    hydrated = true
    try {
      const raw = JSON.parse(await readFile(cachePath, 'utf-8'))
      if (raw?.version !== 1 || !raw.entries || typeof raw.entries !== 'object') return
      const now = Date.now()
      for (const [key, entry] of Object.entries(raw.entries)) {
        if (!entry || typeof entry !== 'object') continue
        if (!(now - Number(entry.at) < LIST_CACHE_TTL_MS)) continue
        listCache.set(key, { ...entry, revision })
      }
    } catch {
      // 无缓存/损坏：忽略，按冷启动处理
    }
  }

  function persistCache() {
    if (!cachePath) return
    persistQueue = persistQueue
      .then(async () => {
        const now = Date.now()
        const entries = {}
        for (const [key, entry] of listCache)
          if (now - entry.at < LIST_CACHE_TTL_MS) entries[key] = entry
        const tmp = `${cachePath}.tmp`
        await writeFile(tmp, JSON.stringify({ version: 1, entries }), 'utf-8')
        await rename(tmp, cachePath)
      })
      .catch(() => undefined)
  }
  function baseUrl(value) {
    const url = new URL(value)
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new Error('请输入不含账号、查询参数或片段的 HTTP(S) 服务器地址')
    }
    return url.href.replace(/\/+$/, '') + '/'
  }

  function requireSession() {
    if (!session?.token || !session?.userId || !session?.serverUrl)
      throw new Error('请先连接 Jellyfin 服务器')
    return session
  }

  function urlFor(active, path, query = {}, withToken = false) {
    const url = new URL(path, active.serverUrl)
    for (const [key, value] of Object.entries(query))
      if (value != null) url.searchParams.set(key, String(value))
    if (withToken) url.searchParams.set('api_key', active.token)
    return url.href
  }

  async function request(active, path, query = {}, options = {}, callContext) {
    const authorization = `MediaBrowser Client="Twilight Echo", Device="Desktop", DeviceId="twilight-echo-jellyfin", Version="0.1.0"${active.token ? `, Token="${active.token}"` : ''}`
    const signals = [AbortSignal.timeout(15000)]
    if (callContext?.signal) signals.push(callContext.signal)
    const response = await fetch(urlFor(active, path, query), {
      ...options,
      headers: { Authorization: authorization, 'Content-Type': 'application/json' },
      redirect: 'error',
      signal: AbortSignal.any(signals)
    })
    if (!response.ok) {
      if (response.status === 401 || response.status === 403)
        throw new Error('Jellyfin 登录失效或账号没有访问权限，请重新登录')
      throw new Error(`Jellyfin 请求失败（HTTP ${response.status}）`)
    }
    return response.status === 204 ? null : response.json()
  }

  // 宿主传入的标识有两种形态：
  // - 播放/收藏列表里的完整 track id：`jellyfin:<enc serverUrl>:<itemId>`
  // - provider 库接口（likeTrack/isTrackLiked）传的 local id：`<enc serverUrl>:<itemId>`
  //   （宿主 resolveProviderTrackId 会剥掉 `jellyfin:` 前缀）
  function itemIdOf(active, value) {
    const raw = typeof value === 'string' ? value : value?.id
    const scoped = typeof raw === 'string' && raw.startsWith('jellyfin:')
      ? raw.slice('jellyfin:'.length)
      : raw
    const prefix = `${encodeURIComponent(active.serverUrl)}:`
    if (typeof scoped !== 'string' || !scoped.startsWith(prefix))
      throw new Error('这首歌曲属于另一台 Jellyfin 服务器，请连接对应服务器')
    return scoped.slice(prefix.length)
  }

  function profile(user) {
    return { userId: user.Id, nickname: user.Name || 'Jellyfin', avatarUrl: '' }
  }

  async function loginWithServer(serverUrl, username, password, callContext) {
    const current = ++revision
    const active = { serverUrl: baseUrl(serverUrl) }
    const result = await request(
      active,
      'Users/AuthenticateByName',
      {},
      {
        method: 'POST',
        body: JSON.stringify({ Username: username, Pw: password })
      },
      callContext
    )
    if (!result?.AccessToken || !result?.User?.Id) throw new Error('Jellyfin 未返回有效登录信息')
    if (current !== revision) throw new Error('登录操作已取消')
    const next = {
      ...active,
      token: result.AccessToken,
      userId: result.User.Id,
      profile: profile(result.User)
    }
    await context.settings.set('session', next)
    session = next
    return { loggedIn: true, profile: next.profile }
  }

  async function checkLogin(callContext) {
    if (!session?.token) return { loggedIn: false, profile: null }
    const active = requireSession()
    try {
      const user = await request(
        active,
        `Users/${encodeURIComponent(active.userId)}`,
        {},
        {},
        callContext
      )
      return { loggedIn: true, profile: profile(user) }
    } catch (error) {
      if (callContext?.signal?.aborted) throw error
      return { loggedIn: false, profile: null }
    }
  }

  function cover(active, item) {
    const id = item.ImageTags?.Primary ? item.Id : item.AlbumId
    const tag = item.ImageTags?.Primary || item.AlbumPrimaryImageTag
    return id && tag
      ? urlFor(
        active,
        `Items/${encodeURIComponent(id)}/Images/Primary`,
        { tag, maxWidth: 500 },
        true
      )
      : null
  }

  function track(active, item) {
    const audioStream = (item.MediaStreams || []).find((s) => s.Type === 'Audio') || {}
    const mediaSource = (item.MediaSources || [])[0] || {}

    // 提取音频参数
    const sampleRate = audioStream.SampleRate ? Number(audioStream.SampleRate) : null
    const bitDepth = audioStream.BitDepth ? Number(audioStream.BitDepth) : null
    const channels = audioStream.Channels != null && Number.isFinite(Number(audioStream.Channels))
      ? Number(audioStream.Channels)
      : null
    const channelLayout = audioStream.ChannelLayout || item.ChannelLayout || null
    const bitRate = audioStream.BitRate || item.TotalBitrate || mediaSource.Bitrate || null
    const format = (audioStream.Codec || item.Container || '').toUpperCase()
    const size = mediaSource.Size || item.Size || 0
    const container = mediaSource.Container || item.Container || ''
    const genre = (item.Genres && item.Genres.length > 0) ? item.Genres.join(' / ') : ''

    // 音质评级判定 (Hi-Res / Lossless / HQ / SQ / Standard)
    let quality = 'Standard'
    // 严格口径：Hi-Res 需要采样率超过 48kHz（24bit/48kHz 计为 Lossless）
    if (sampleRate && sampleRate > 48000) {
      quality = 'Hi-Res'
    } else if (['FLAC', 'ALAC', 'WAV', 'APE', 'AIFF'].includes(format)) {
      quality = 'Lossless'
    } else if (bitRate && bitRate >= 320000) {
      quality = 'HQ'
    }

    const audioMeta = {
      sampleRate,
      bitDepth,
      channels,
      channelCount: channels,
      channelLayout,
      bitRate,
      format,
      size,
      fileSize: size,
      quality,
      container,
      genre
    }

    return {
      id: `jellyfin:${encodeURIComponent(active.serverUrl)}:${item.Id}`,
      title: item.Name || '',
      artist: (item.Artists || []).join(' / '),
      artists: (item.ArtistItems || []).map((artist) => ({ id: artist.Id, name: artist.Name })),
      album: item.Album || '',
      filePath: item.Path || '',
      fileName: item.Name || '',
      duration: (item.RunTimeTicks || 0) / 10000000,
      cover: cover(active, item),
      lyrics: null,
      source: 'jellyfin',
      genre,
      genres: item.Genres || [],

      // 平铺常用命名
      sampleRate,
      bitDepth,
      channels,
      channelCount: channels,
      channelLayout,
      format,
      size,
      fileSize: size,
      bitRate,
      bitrate: bitRate,
      container,
      quality,

      // 常见别名（下划线与大写兼容）
      sample_rate: sampleRate,
      bit_depth: bitDepth,
      channel_count: channels,
      channel_layout: channelLayout,

      // 嵌套元数据容器（Twilight Echo 宿主常见的结构绑定）
      mediaInfo: { ...audioMeta },
      audioInfo: { ...audioMeta },
      qualityInfo: { ...audioMeta }
    }
  }

  function playlist(active, item) {
    return {
      id: item.Id,
      name: item.Name || '',
      cover: cover(active, item),
      trackCount: item.ChildCount || 0
    }
  }

  // 只保留宿主真正读取的字段：MediaStreams 提供采样率/位深/声道/码率，
  // MediaSources 是条目 Size（文件大小，宿主 TrackInfo 会显示）的唯一来源，
  // Path 提供路径，Genres 提供风格。PrimaryImageAspectRatio 无人使用且让
  // 每页体积近乎翻倍（实测 3569 首：2.24MB → 1.24MB/500），已移除。
  const QUERY_FIELDS = 'MediaStreams,MediaSources,Path,Size,Genres,ChannelLayout'

  async function items(active, query, callContext) {
    return request(
      active,
      'Items',
      {
        UserId: active.userId,
        Recursive: true,
        IncludeItemTypes: 'Audio',
        Fields: QUERY_FIELDS,
        Limit: PAGE_SIZE,
        ...query
      },
      {},
      callContext
    )
  }

  // 顺序分页在 3569 首的库上要 36 个来回（实测 14.4s）。先取首页拿到
  // TotalRecordCount，再按固定并发把剩余页并发拉取并保持原始顺序。
  async function allPages(active, path, query, callContext) {
    const fetchPage = (offset) =>
      request(
        active,
        path,
        { UserId: active.userId, Limit: PAGE_SIZE, StartIndex: offset, ...query },
        {},
        callContext
      )

    const first = await fetchPage(0)
    const result = [...(first.Items || [])]
    const total = first.TotalRecordCount
    if (result.length === 0 || result.length < PAGE_SIZE) return result
    if (typeof total !== 'number') {
      // 服务器没给总数：退回顺序分页
      for (let offset = PAGE_SIZE; ; offset += PAGE_SIZE) {
        const page = await fetchPage(offset)
        const entries = page.Items || []
        result.push(...entries)
        if (entries.length < PAGE_SIZE) return result
      }
    }
    if (result.length >= total) return result

    const offsets = []
    for (let offset = PAGE_SIZE; offset < total; offset += PAGE_SIZE) offsets.push(offset)
    const pages = new Array(offsets.length)
    let cursor = 0
    await Promise.all(
      Array.from({ length: Math.min(PAGE_CONCURRENCY, offsets.length) }, async () => {
        while (cursor < offsets.length) {
          const index = cursor++
          pages[index] = (await fetchPage(offsets[index])).Items || []
        }
      })
    )
    for (const page of pages) result.push(...page)
    return result
  }

  await context.twilight.providers.register({
    id: 'jellyfin',
    name: 'Jellyfin',
    capabilities: ['login', 'search', 'playbackUrl', 'cover', 'playlist', 'library', 'mediaInfo'],
    ui: {
      icon: 'pi pi-server',
      description: '连接自己的音乐服务器',
      authType: 'settings',
      streamingLibraryTab: true,
      streamingSearch: true,
      unifiedLibrary: true
    },
    loginWithServer,
    checkLogin,
    getProfile: async (callContext) => (await checkLogin(callContext)).profile,
    logout: async () => {
      revision++
      session = null
      await context.settings.delete('session')
    },
    searchSongs: async (keywords, limit = 50, offset = 0, callContext) => {
      const active = requireSession()
      const page = await items(
        active,
        {
          SearchTerm: keywords,
          Limit: Math.min(200, Math.max(1, limit)),
          StartIndex: Math.max(0, offset)
        },
        callContext
      )
      return {
        items: (page.Items || []).map((item) => track(active, item)),
        total: page.TotalRecordCount || 0
      }
    },
    fetchRecommendSongs: async (callContext) => {
      const active = requireSession()
      const page = await items(
        active,
        { SortBy: 'DateCreated', SortOrder: 'Descending', Limit: 30 },
        callContext
      )
      return (page.Items || []).map((item) => track(active, item))
    },
    fetchUserLibrary: async (force, callContext) => {
      const active = requireSession()
      await hydrateCache()
      // 库摘要只有 3 个请求（实测 ~130ms），刻意不缓存：收藏数/全部音乐数
      // 必须每次与服务端一致，否则头部会显示旧的 25 项、列表却是新的 26 首。
      const [entries, allPage, favoritePage] = await Promise.all([
        allPages(
          active,
          'Items',
          { Recursive: true, IncludeItemTypes: 'Playlist' },
          callContext
        ),
        items(active, { Limit: 1, Fields: '' }, callContext),
        items(active, { Limit: 1, Fields: '', IsFavorite: true }, callContext)
      ])
      return {
        likedPlaylist: { id: '@favorite', name: '收藏', cover: null, trackCount: favoritePage.TotalRecordCount || 0 },
        playlists: [
          { id: '@all', name: '全部音乐', cover: null, trackCount: allPage.TotalRecordCount || 0 },
          ...entries.map((item) => playlist(active, item))
        ]
      }
    },
    fetchPlaylistTracks: async (playlistId, force, callContext) => {
      const active = requireSession()
      await hydrateCache()
      const cacheKey = cacheKeyFor(active, `tracks:${playlistId}`)
      const cached = listCache.get(cacheKey)
      if (!force && cached?.revision === revision && Date.now() - cached.at < LIST_CACHE_TTL_MS)
        return cached.value
      const entries =
        playlistId === '@all'
          ? await allPages(
            active,
            'Items',
            { Recursive: true, IncludeItemTypes: 'Audio', Fields: QUERY_FIELDS },
            callContext
          )
          : playlistId === '@favorite'
          ? await allPages(
            active,
            'Items',
            { Recursive: true, IncludeItemTypes: 'Audio', IsFavorite: true, Fields: QUERY_FIELDS },
            callContext
          )
          : await allPages(
            active,
            `Playlists/${encodeURIComponent(playlistId)}/Items`,
            { Fields: QUERY_FIELDS },
            callContext
          )
      const tracks = entries.filter((item) => item.Type === 'Audio').map((item) => track(active, item))
      listCache.set(cacheKey, { revision, at: Date.now(), value: tracks })
      persistCache()
      return tracks
    },
    getPlaybackUrl: async (item, _options, callContext) => {
      callContext?.signal?.throwIfAborted()
      const active = requireSession()
      const itemId = itemIdOf(active, item)

      // Jellyfin 12 移除了 `api_key` 查询参数与 `X-Emby-Token` 头；
      // 播放器打开的 URL 用 `ApiKey` 查询参数携带访问令牌。
      // 另外该版本的 universal 端点在缺省（无 Container）时会 500，
      // 必须带上与源文件一致的 Container 才能返回直链。
      const container = (item.container || item.mediaInfo?.container || '').toLowerCase()
      const streamUrl = new URL(
        `Audio/${encodeURIComponent(itemId)}/universal`,
        active.serverUrl
      )
      streamUrl.searchParams.set('UserId', active.userId)
      streamUrl.searchParams.set('DeviceId', 'twilight-echo-jellyfin')
      streamUrl.searchParams.set('ApiKey', active.token)
      if (container) streamUrl.searchParams.set('Container', container)
      else {
        // 兜底走服务器转码：Jellyfin 12.1 仅接受 mp3 转码组合
        streamUrl.searchParams.set('EnableRedirection', 'false')
        streamUrl.searchParams.set('AudioCodec', 'mp3')
        streamUrl.searchParams.set('TranscodingContainer', 'mp3')
      }
      // 每次 resolve 生成唯一 PlaySessionId：重复播放同一首歌时，
      // 宿主引擎看到相同 source 会走“重连旧流 + seek”捷径，而旧 HTTP 流
      // 已到 EOF、连接已断，seek 返回 -1（“音频跳转失败”）。URL 唯一化
      // 让引擎按全新 source 完整重开。Jellyfin 接受任意 PlaySessionId。
      streamUrl.searchParams.set('PlaySessionId', `te-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
      return streamUrl.href
    },
    likeTrack: async (item, liked, callContext) => {
      callContext?.signal?.throwIfAborted()
      const active = requireSession()
      const id = typeof item === 'string' ? item : item?.id
      const itemId = itemIdOf(active, item)
      await request(
        active,
        `Users/${active.userId}/FavoriteItems/${encodeURIComponent(itemId)}`,
        {},
        { method: liked ? 'POST' : 'DELETE' },
        callContext
      )
      // 收藏状态变化会让收藏列表与库计数失效（键现在是 serverUrl|userId|suffix）
      for (const key of [...listCache.keys()])
        if (key.startsWith(`${active.serverUrl}|${active.userId}|`)) listCache.delete(key)
      persistCache()
      return { id, liked }
    },
    isTrackLiked: async (item, callContext) => {
      const active = requireSession()
      const itemId = itemIdOf(active, item)
      const page = await items(
        active,
        { Ids: itemId, IsFavorite: true, Limit: 1 },
        callContext
      )
      return (page.Items || []).some((entry) => entry.Id === itemId)
    }
  })
}

export function deactivate() { }