/**
 * Agent tool layer. Tool implementations call the host context APIs added in
 * Twilight Echo API v4 (library / appSettings / host / player). Every write
 * operation goes through the `confirm` callback, which renders a preview card
 * in the chat panel and waits for the user's approval.
 *
 * Track versions seen in query results are cached so metadata patches can be
 * optimistic-locked without asking the model to track versions.
 */

import { scanLibrary, compactTrack } from './scans.mjs'
import { throwIfAborted } from './runtime.mjs'

const MAX_TOOL_RESULT_CHARS = 24000

export function createTools({ context, confirm }) {
  const twilight = context.twilight
  /** id -> { version, record } */
  const trackCache = new Map()

  const definitions = [
    {
      name: 'get_app_settings',
      description:
        '读取应用当前完整设置（外观、DSP 音频处理、播放行为、曲库目录等）。调设置前先用它了解现状。',
      parameters: { type: 'object', properties: {}, additionalProperties: false }
    },
    {
      name: 'update_app_settings',
      description:
        '修改应用设置。patch 是部分字段的对象（只包含要改的字段）。会先给用户展示修改预览并等待确认。字段名以 get_app_settings 返回为准。',
      parameters: {
        type: 'object',
        properties: {
          patch: { type: 'object', description: '要修改的设置字段，只包含变化的键' },
          reason: { type: 'string', description: '一句话说明为什么这样改' }
        },
        required: ['patch', 'reason'],
        additionalProperties: false
      },
      confirm: 'settings'
    },
    {
      name: 'capture_screenshot',
      description:
        '截取应用主窗口的当前画面（JPEG）。用于观察界面实际效果，比如主题、布局、DSP 工作台状态。',
      parameters: { type: 'object', properties: {}, additionalProperties: false }
    },
    {
      name: 'query_library',
      description:
        '分页查询本地曲库。可按关键词、艺术家、流派过滤，可排序。返回曲目摘要（含 bpm、格式、采样率、年代）。',
      parameters: {
        type: 'object',
        properties: {
          search: { type: 'string', description: '标题/艺术家/专辑关键词' },
          artist: { type: 'string' },
          genre: { type: 'string' },
          sort: {
            type: 'string',
            enum: ['title', 'artist', 'album', 'addedAt', 'recentlyAdded', 'lastPlayed', 'duration', 'sampleRate']
          },
          direction: { type: 'string', enum: ['asc', 'desc'] },
          offset: { type: 'integer', minimum: 0 },
          limit: { type: 'integer', minimum: 1, maximum: 200, description: '默认 50' }
        },
        additionalProperties: false
      }
    },
    {
      name: 'get_tracks',
      description: '按 id 获取曲目完整信息（含歌词、响度增益、音质细节）。最多 50 首。',
      parameters: {
        type: 'object',
        properties: { ids: { type: 'array', items: { type: 'string' }, maxItems: 50 } },
        required: ['ids'],
        additionalProperties: false
      }
    },
    {
      name: 'patch_track_metadata',
      description:
        '批量修正曲目元数据（genre、title、artist、album、albumArtist、releaseDate、lyrics、bpm 等）。会展示修改清单等待用户确认；只提供 id 和要改的字段，不要编造 version。',
      parameters: {
        type: 'object',
        properties: {
          patches: {
            type: 'array',
            maxItems: 200,
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                patch: { type: 'object', description: '要修改的元数据字段' }
              },
              required: ['id', 'patch']
            }
          },
          reason: { type: 'string' }
        },
        required: ['patches', 'reason'],
        additionalProperties: false
      },
      confirm: 'patches'
    },
    {
      name: 'get_cover',
      description: '获取一首曲目的封面图片（视觉输入）。用于检查封面是否缺失、低清或与内容不符。',
      parameters: {
        type: 'object',
        properties: { trackId: { type: 'string' } },
        required: ['trackId'],
        additionalProperties: false
      }
    },
    {
      name: 'list_playlists',
      description: '列出本地歌单（含曲目数）。',
      parameters: { type: 'object', properties: {}, additionalProperties: false }
    },
    {
      name: 'create_playlist',
      description:
        '创建歌单并加入曲目。用于把打好的标签（mood/场景/年代/主题）落成歌单。会展示预览等待确认。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '歌单名，建议带上「AI」或主题前缀' },
          trackIds: { type: 'array', items: { type: 'string' }, maxItems: 1000 }
        },
        required: ['name', 'trackIds'],
        additionalProperties: false
      },
      confirm: 'playlist'
    },
    {
      name: 'add_to_playlist',
      description: '向已有歌单追加曲目。会展示预览等待确认。',
      parameters: {
        type: 'object',
        properties: {
          playlistId: { type: 'string' },
          trackIds: { type: 'array', items: { type: 'string' }, maxItems: 1000 }
        },
        required: ['playlistId', 'trackIds'],
        additionalProperties: false
      },
      confirm: 'playlist'
    },
    {
      name: 'play_tracks',
      description: '用一组曲目替换播放队列并开始播放（可指定起始曲目）。',
      parameters: {
        type: 'object',
        properties: {
          ids: { type: 'array', items: { type: 'string' }, maxItems: 500 },
          startIndex: { type: 'integer', minimum: 0 }
        },
        required: ['ids'],
        additionalProperties: false
      }
    },
    {
      name: 'player_control',
      description: '播放控制：播放/暂停/切歌/停止/音量/进度/播放模式。',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['play', 'pause', 'toggle', 'stop', 'next', 'previous', 'volume', 'seek', 'mode']
          },
          volume: { type: 'number', minimum: 0, maximum: 1 },
          position: { type: 'number', minimum: 0, description: '秒' },
          mode: { type: 'string', enum: ['sequential', 'listLoop', 'repeat', 'shuffle'] }
        },
        required: ['action'],
        additionalProperties: false
      }
    },
    {
      name: 'get_playback_info',
      description: '读取当前播放状态（曲目、进度、音量、模式）。',
      parameters: { type: 'object', properties: {}, additionalProperties: false }
    },
    {
      name: 'find_duplicates',
      description:
        '本地检测疑似重复曲目（规范化标题+艺术家相同，时长相差 3 秒内）。不消耗 AI token。返回分组列表供用户决定处理方式。',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 5, description: '最多扫描批次，默认 3（每批 200 首）' }
        },
        additionalProperties: false
      }
    },
    {
      name: 'library_quality_report',
      description:
        '本地统计曲库质量：格式/采样率/位深分布、缺失流派、缺失封面、缺失 BPM。不消耗 AI token。',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 20, description: '扫描批次，默认 10（每批 200 首）' }
        },
        additionalProperties: false
      }
    }
  ]

  function list() {
    return definitions.map(({ name, description, parameters }) => ({ name, description, parameters }))
  }

  async function execute(name, args, signal, confirmWrite) {
    const handler = handlers[name]
    if (!handler) return { error: `未知工具：${name}` }
    try {
      throwIfAborted(signal)
      const value = await handler(args ?? {}, signal, confirmWrite ?? confirm)
      throwIfAborted(signal)
      return { value }
    } catch (error) {
      if (signal?.aborted) throw error
      return { error: error instanceof Error ? error.message : String(error) }
    }
  }

  const handlers = {
    async get_app_settings() {
      const settings = await twilight.appSettings.get()
      return { settings }
    },
    async update_app_settings({ patch, reason }, signal, confirmWrite) {
      if (!patch || typeof patch !== 'object' || !Object.keys(patch).length) {
        throw new Error('patch 不能为空')
      }
      const approved = await confirmWrite({
        kind: 'settings',
        title: '修改应用设置',
        reason,
        preview: { patch }
      })
      throwIfAborted(signal)
      if (!approved) return { applied: false, reason: '用户取消了本次修改' }
      const result = await twilight.appSettings.update(patch)
      return { applied: true, settings: result }
    },
    async capture_screenshot() {
      const image = await twilight.host.captureScreenshot()
      if (!image) throw new Error('当前无法截图（窗口可能最小化）')
      return { image }
    },
    async query_library(query) {
      const page = await twilight.library.queryTracks({
        search: str(query.search),
        artist: str(query.artist),
        genre: str(query.genre),
        sort: query.sort,
        direction: query.direction,
        offset: int(query.offset, 0, 0, 10_000_000),
        limit: int(query.limit, 50, 1, 200)
      })
      rememberPage(page)
      return {
        total: page.total,
        offset: page.offset,
        revision: page.revision,
        tracks: (page.tracks ?? []).map(compactTrack)
      }
    },
    async get_tracks({ ids }) {
      if (!Array.isArray(ids) || !ids.length) throw new Error('ids 不能为空')
      const page = await twilight.library.getTracksByIds(ids.slice(0, 50))
      rememberPage(page)
      return { tracks: (page.tracks ?? []).map(detailTrack) }
    },
    async patch_track_metadata({ patches, reason }, signal, confirmWrite) {
      if (!Array.isArray(patches) || !patches.length) throw new Error('patches 不能为空')
      const bounded = patches.slice(0, 200)
      const missing = bounded.filter((patch) => !patch || typeof patch !== 'object' || !patch.id || !patch.patch)
      if (missing.length) throw new Error('每个补丁都需要 id 和 patch')
      const ids = bounded.map((patch) => patch.id)
      await refreshTrackCache(ids)
      const enriched = bounded.map((patch) => {
        const cached = trackCache.get(patch.id)
        return {
          id: patch.id,
          expectedVersion: cached?.version ?? 0,
          patch: sanitizePatch(patch.patch)
        }
      })
      const preview = enriched.map((patch) => ({
        title: trackCache.get(patch.id)?.record?.title ?? patch.id,
        artist: trackCache.get(patch.id)?.record?.artist ?? '',
        changes: patch.patch
      }))
      const approved = await confirmWrite({
        kind: 'patches',
        title: `修正 ${enriched.length} 首曲目元数据`,
        reason,
        preview: { patches: preview.slice(0, 50) }
      })
      throwIfAborted(signal)
      if (!approved) return { applied: false, reason: '用户取消了本次修改' }
      const result = await twilight.library.patchTracks(enriched)
      rememberPage(result)
      return { applied: true, count: enriched.length, tracks: (result.tracks ?? []).map(compactTrack) }
    },
    async get_cover({ trackId }) {
      const image = await twilight.library.getCover(trackId)
      if (!image) return { cover: null, note: '该曲目没有封面' }
      return { image }
    },
    async list_playlists() {
      return await twilight.library.listPlaylists()
    },
    async create_playlist({ name, trackIds }, signal, confirmWrite) {
      const listName = String(name ?? '').trim().slice(0, 80)
      if (!listName) throw new Error('歌单名不能为空')
      if (!Array.isArray(trackIds) || !trackIds.length) throw new Error('trackIds 不能为空')
      await refreshTrackCache(trackIds.slice(0, 50))
      const preview = trackIds.slice(0, 30).map((id) => ({
        title: trackCache.get(id)?.record?.title ?? id,
        artist: trackCache.get(id)?.record?.artist ?? ''
      }))
      const approved = await confirmWrite({
        kind: 'playlist',
        title: `创建歌单「${listName}」`,
        reason: `将加入 ${trackIds.length} 首曲目`,
        preview: { tracks: preview, total: trackIds.length }
      })
      throwIfAborted(signal)
      if (!approved) return { created: false, reason: '用户取消了本次创建' }
      const created = await twilight.library.createPlaylist(listName)
      throwIfAborted(signal)
      const playlistId = extractPlaylistId(created)
      if (!playlistId) throw new Error('歌单已创建但无法回读 id，请用 list_playlists 确认')
      await twilight.library.addTracksToPlaylist(playlistId, trackIds)
      return { created: true, playlistId, name: listName, count: trackIds.length }
    },
    async add_to_playlist({ playlistId, trackIds }, signal, confirmWrite) {
      if (!playlistId || !Array.isArray(trackIds) || !trackIds.length) {
        throw new Error('需要 playlistId 和 trackIds')
      }
      const approved = await confirmWrite({
        kind: 'playlist',
        title: '向歌单追加曲目',
        reason: `将追加 ${trackIds.length} 首曲目`,
        preview: { playlistId, total: trackIds.length }
      })
      throwIfAborted(signal)
      if (!approved) return { added: false, reason: '用户取消了本次操作' }
      await twilight.library.addTracksToPlaylist(playlistId, trackIds)
      return { added: true, count: trackIds.length }
    },
    async play_tracks({ ids, startIndex }) {
      if (!Array.isArray(ids) || !ids.length) throw new Error('ids 不能为空')
      const bounded = ids.slice(0, 500)
      await twilight.player.playTracks(bounded, int(startIndex, 0, 0, bounded.length - 1))
      return { playing: bounded.length }
    },
    async player_control({ action, volume, position, mode }) {
      const player = twilight.player
      switch (action) {
        case 'play':
          await player.play()
          break
        case 'pause':
          await player.pause()
          break
        case 'toggle':
          await player.togglePause()
          break
        case 'stop':
          await player.stop()
          break
        case 'next':
          await player.next()
          break
        case 'previous':
          await player.previous()
          break
        case 'volume':
          await player.setVolume(Math.min(1, Math.max(0, Number(volume) || 0)))
          break
        case 'seek':
          await player.seek(Math.max(0, Number(position) || 0))
          break
        case 'mode':
          await player.setPlayMode(mode)
          break
        default:
          throw new Error(`未知播放操作：${action}`)
      }
      return { done: action }
    },
    async get_playback_info() {
      return { playback: await twilight.player.getPlaybackInfo() }
    },
    async find_duplicates({ limit }, signal) {
      return scanLibrary({ library: twilight.library, kind: 'duplicates', signal, maxPages: int(limit, 3, 1, 5), onPage: rememberPage })
    },
    async library_quality_report({ limit }, signal) {
      return scanLibrary({ library: twilight.library, kind: 'quality', signal, maxPages: int(limit, 10, 1, 20), onPage: rememberPage })
    }
  }

  function rememberPage(page) {
    for (const record of page?.tracks ?? []) {
      if (!record?.id) continue
      trackCache.set(record.id, { version: Number(record.version ?? record.expectedVersion ?? 0), record })
      if (trackCache.size > 20000) trackCache.delete(trackCache.keys().next().value)
    }
  }

  async function refreshTrackCache(ids) {
    const missing = ids.filter((id) => !trackCache.has(id))
    for (let index = 0; index < missing.length; index += 50) {
      rememberPage(await twilight.library.getTracksByIds(missing.slice(index, index + 50)))
    }
  }

  return { list, execute, definitions }
}

/* --------------------------------------------------------------------------- */

function str(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function int(value, fallback, min, max) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.floor(number)))
}

function detailTrack(record) {
  const compact = compactTrack(record)
  return {
    ...compact,
    albumArtist: record.albumArtist ?? '',
    trackNumber: record.trackNumber ?? undefined,
    discNumber: record.discNumber ?? undefined,
    lyrics: truncate(String(record.lyrics ?? ''), 2000),
    replayGainTrackGainDb: record.replayGainTrackGainDb ?? undefined,
    addedAt: record.addedAt
  }
}

const PATCH_ALLOWED = new Set([
  'title',
  'artist',
  'artists',
  'album',
  'albumArtist',
  'albumId',
  'genre',
  'releaseDate',
  'trackNumber',
  'discNumber',
  'lyrics',
  'translatedLyrics',
  'romanizedLyrics',
  'bpm'
])

function sanitizePatch(patch) {
  const clean = {}
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (PATCH_ALLOWED.has(key) && value !== undefined) clean[key] = value
  }
  if (!Object.keys(clean).length) throw new Error('补丁不含可写字段（title/artist/album/genre/lyrics/bpm 等）')
  return clean
}

function extractPlaylistId(created) {
  if (!created || typeof created !== 'object') return null
  if (typeof created.id === 'string') return created.id
  const items = created.items ?? created.playlists
  if (Array.isArray(items) && items.length && typeof items[0]?.id === 'string') return items[0].id
  return null
}

export function truncate(text, max) {
  if (text.length <= max) return text
  return `${text.slice(0, max)}…`
}

export function truncateToolResult(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return truncate(text, MAX_TOOL_RESULT_CHARS)
}
