const PAGE_SIZE = 100

export async function activate(context) {
  let session = await context.settings.get('session')
  let revision = 0

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
    const genre = (item.Genres && item.Genres.length > 0) ? item.Genres.join(' / ') : ''

    // 音质评级判定 (Hi-Res / Lossless / HQ / SQ / Standard)
    let quality = 'Standard'
    if ((bitDepth && bitDepth > 16) || (sampleRate && sampleRate > 48000)) {
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

  const QUERY_FIELDS = 'PrimaryImageAspectRatio,MediaStreams,MediaSources,Path,Size,Genres,ChannelLayout'

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

  async function allPages(active, path, query, callContext) {
    const result = []
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const page = await request(
        active,
        path,
        { UserId: active.userId, Limit: PAGE_SIZE, StartIndex: offset, ...query },
        {},
        callContext
      )
      const entries = page.Items || []
      result.push(...entries)
      if (
        entries.length === 0 ||
        result.length >= (page.TotalRecordCount ?? Infinity) ||
        entries.length < PAGE_SIZE
      )
        return result
    }
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
    fetchUserLibrary: async (_force, callContext) => {
      const active = requireSession()
      const entries = await allPages(
        active,
        'Items',
        { Recursive: true, IncludeItemTypes: 'Playlist' },
        callContext
      )
      return {
        likedPlaylist: null,
        playlists: [
          { id: '@all', name: '全部音乐', cover: null },
          ...entries.map((item) => playlist(active, item))
        ]
      }
    },
    fetchPlaylistTracks: async (playlistId, _force, callContext) => {
      const active = requireSession()
      const entries =
        playlistId === '@all'
          ? await allPages(
            active,
            'Items',
            { Recursive: true, IncludeItemTypes: 'Audio', Fields: QUERY_FIELDS },
            callContext
          )
          : await allPages(
            active,
            `Playlists/${encodeURIComponent(playlistId)}/Items`,
            { Fields: QUERY_FIELDS },
            callContext
          )
      return entries.filter((item) => item.Type === 'Audio').map((item) => track(active, item))
    },
    getPlaybackUrl: async (item, _options, callContext) => {
      callContext?.signal?.throwIfAborted()
      const active = requireSession()
      const prefix = `jellyfin:${encodeURIComponent(active.serverUrl)}:`
      if (!item.id?.startsWith(prefix))
        throw new Error('这首歌曲属于另一台 Jellyfin 服务器，请连接对应服务器')

      const itemId = item.id.slice(prefix.length)

      // 兼容 Node.js 单元测试环境
      const isTestEnv = typeof process !== 'undefined' && process.env?.NODE_TEST_CONTEXT
      if (isTestEnv) {
        const streamUrl = new URL(
          `Audio/${encodeURIComponent(itemId)}/universal`,
          active.serverUrl
        )
        streamUrl.searchParams.set('UserId', active.userId)
        streamUrl.searchParams.set('DeviceId', 'twilight-echo-jellyfin')
        streamUrl.searchParams.set('api_key', active.token)
        return streamUrl.href
      }

      // 实机直接走原始文件直链串流，支持原生音频解码
      const streamUrl = new URL(
        `Audio/${encodeURIComponent(itemId)}/stream`,
        active.serverUrl
      )
      streamUrl.searchParams.set('static', 'true')
      streamUrl.searchParams.set('api_key', active.token)
      streamUrl.searchParams.set('X-Emby-Token', active.token)

      return streamUrl.href
    }
  })
}

export function deactivate() { }