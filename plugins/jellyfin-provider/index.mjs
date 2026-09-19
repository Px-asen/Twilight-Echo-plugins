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
    return {
      id: `jellyfin:${encodeURIComponent(active.serverUrl)}:${item.Id}`,
      title: item.Name || '',
      artist: (item.Artists || []).join(' / '),
      artists: (item.ArtistItems || []).map((artist) => ({ id: artist.Id, name: artist.Name })),
      album: item.Album || '',
      filePath: '',
      fileName: item.Name || '',
      duration: (item.RunTimeTicks || 0) / 10000000,
      size: 0,
      cover: cover(active, item),
      lyrics: null,
      source: 'jellyfin'
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

  async function items(active, query, callContext) {
    return request(
      active,
      'Items',
      {
        UserId: active.userId,
        Recursive: true,
        IncludeItemTypes: 'Audio',
        Fields: 'PrimaryImageAspectRatio',
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
    capabilities: ['login', 'search', 'playbackUrl', 'cover', 'playlist', 'library'],
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
              { Recursive: true, IncludeItemTypes: 'Audio' },
              callContext
            )
          : await allPages(
              active,
              `Playlists/${encodeURIComponent(playlistId)}/Items`,
              {},
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
      return urlFor(
        active,
        `Audio/${encodeURIComponent(item.id.slice(prefix.length))}/universal`,
        {
          UserId: active.userId,
          DeviceId: 'twilight-echo-jellyfin',
          Container: 'flac,mp3,aac,m4a,ogg,wav,opus',
          TranscodingContainer: 'mp3',
          TranscodingProtocol: 'http',
          AudioCodec: 'mp3',
          EnableRedirection: false
        },
        true
      )
    }
  })
}

export function deactivate() {}
