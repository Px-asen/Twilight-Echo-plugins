import test from 'node:test'
import assert from 'node:assert/strict'
import { createTools, truncateToolResult } from './tools.mjs'

function makeContext(overrides = {}) {
  const state = { queries: [], patched: [], playlists: [] }
  const tracks = overrides.tracks ?? [
    { id: 't1', title: 'Blue in Green', artist: 'Miles Davis', album: 'Kind of Blue', genre: 'Jazz', duration: 337, format: 'FLAC', sampleRate: 44100, bitDepth: 16, version: 2, cover: 'cover://a.jpg' },
    { id: 't2', title: 'Blue in Green (Live)', artist: 'Miles Davis', album: 'Live', genre: '', duration: 338, format: 'MP3', sampleRate: 44100, version: 5 },
    { id: 't3', title: 'So What', artist: 'Miles Davis', album: 'Kind of Blue', genre: 'Jazz', duration: 545, format: 'FLAC', sampleRate: 96000, bitDepth: 24, bpm: 120, version: 1 }
  ]
  return {
    state,
    context: {
      twilight: {
        library: {
          queryTracks: overrides.queryTracks ?? (async (query) => {
            state.queries.push(query)
            const filtered = query.ids
              ? tracks.filter((track) => query.ids.includes(track.id))
              : query.search
                ? tracks.filter((track) => track.title.toLowerCase().includes(query.search.toLowerCase()))
                : tracks
            const offset = query.offset ?? 0
            const limit = query.limit ?? tracks.length
            return {
              tracks: filtered.slice(offset, offset + limit),
              total: filtered.length,
              offset,
              revision: 9
            }
          }),
          getTracksByIds: async (ids) => ({ tracks: tracks.filter((track) => ids.includes(track.id)), total: ids.length }),
          patchTracks: async (patches) => {
            state.patched.push(patches)
            return { tracks: [], total: 0 }
          },
          getCover: async (id) => (id === 't1' ? 'data:image/jpeg;base64,Q292ZXI=' : null),
          listPlaylists: async () => ({ items: state.playlists.map((playlist) => ({ id: playlist.id, name: playlist.name, count: playlist.count })) }),
          createPlaylist: async (name) => {
            const playlist = { id: `pl_${state.playlists.length + 1}`, name, count: 0 }
            state.playlists.push(playlist)
            return playlist
          },
          addTracksToPlaylist: async (playlistId, trackIds) => {
            const playlist = state.playlists.find((entry) => entry.id === playlistId)
            if (playlist) playlist.count += trackIds.length
          },
          removeTracksFromPlaylist: async () => {}
        },
        appSettings: { get: async () => ({ theme: 'dark' }), update: async (patch) => ({ ...patch }) },
        host: { captureScreenshot: async () => 'data:image/jpeg;base64,egot' },
        player: {
          getPlaybackInfo: async () => ({ state: 'paused' }),
          play: async () => {}, pause: async () => {}, togglePause: async () => {}, stop: async () => {},
          next: async () => {}, previous: async () => {},
          playTracks: async (ids) => { state.played = ids },
          setVolume: async (v) => { state.volume = v }, seek: async () => {}, setPlayMode: async () => {}
        }
      }
    }
  }
}

const approveAll = async () => true
const rejectAll = async () => false

test('query_library 返回紧凑 DTO 并记住版本', async () => {
  const { context } = makeContext()
  const tools = createTools({ context })
  const result = await tools.execute('query_library', { search: 'blue' }, null, approveAll)
  assert.equal(result.value.tracks.length, 2)
  assert.equal(result.value.tracks[0].id, 't1')
  assert.equal(result.value.tracks[0].format, 'FLAC')
  assert.equal(result.value.tracks[1].year, undefined)
})

test('patch_track_metadata 自动补 expectedVersion 且过滤非法字段', async () => {
  const { context, state } = makeContext()
  const tools = createTools({ context })
  const result = await tools.execute(
    'patch_track_metadata',
    { patches: [{ id: 't1', patch: { genre: 'Jazz', filePath: '/evil', title: 'Blue in Green' } }], reason: '整理' },
    null,
    approveAll
  )
  assert.equal(result.value.applied, true)
  assert.deepEqual(state.patched[0], [
    { id: 't1', expectedVersion: 2, patch: { genre: 'Jazz', title: 'Blue in Green' } }
  ])
})

test('patch 字段全部非法时报错', async () => {
  const { context } = makeContext()
  const tools = createTools({ context })
  const result = await tools.execute(
    'patch_track_metadata',
    { patches: [{ id: 't1', patch: { filePath: '/x' } }], reason: 'r' },
    null,
    approveAll
  )
  assert.ok(result.error)
  assert.match(result.error, /可写字段/)
})

test('create_playlist 需要确认，拒绝时不创建', async () => {
  const { context, state } = makeContext()
  const tools = createTools({ context })
  const rejected = await tools.execute('create_playlist', { name: '深夜爵士', trackIds: ['t1', 't3'] }, null, rejectAll)
  assert.equal(rejected.value.created, false)
  assert.equal(state.playlists.length, 0)

  const approved = await tools.execute('create_playlist', { name: '深夜爵士', trackIds: ['t1', 't3'] }, null, approveAll)
  assert.equal(approved.value.created, true)
  assert.equal(approved.value.playlistId, 'pl_1')
  assert.equal(state.playlists[0].count, 2)
})

test('find_duplicates 用规范化键分组', async () => {
  const { context } = makeContext()
  const tools = createTools({ context })
  const result = await tools.execute('find_duplicates', { limit: 1 }, null, approveAll)
  assert.equal(result.value.duplicateGroups.length, 1)
  const group = result.value.duplicateGroups[0]
  assert.equal(group.keep.id, 't1')
  assert.deepEqual(group.duplicates.map((track) => track.id), ['t2'])
})

test('library_quality_report 汇总音质与缺失', async () => {
  const { context } = makeContext()
  const tools = createTools({ context })
  const result = await tools.execute('library_quality_report', { limit: 1 }, null, approveAll)
  const stats = result.value
  assert.equal(stats.total, 3)
  assert.equal(stats.formats.FLAC, 2)
  assert.equal(stats.hiRes, 1)
  assert.equal(stats.missingGenre, 1)
  assert.equal(stats.missingCover, 2)
  assert.ok(stats.coverage.genre > 0.6)
})

test('player_control 与 play_tracks 直达宿主', async () => {
  const { context, state } = makeContext()
  const tools = createTools({ context })
  await tools.execute('player_control', { action: 'volume', volume: 0.3 }, null, approveAll)
  assert.equal(state.volume, 0.3)
  await tools.execute('play_tracks', { ids: ['t1', 't3'], startIndex: 1 }, null, approveAll)
  assert.deepEqual(state.played, ['t1', 't3'])
})

test('capture_screenshot 与 get_cover 返回图片', async () => {
  const { context } = makeContext()
  const tools = createTools({ context })
  const shot = await tools.execute('capture_screenshot', {}, null, approveAll)
  assert.match(shot.value.image, /^data:image\/jpeg;base64,/)
  const cover = await tools.execute('get_cover', { trackId: 't1' }, null, approveAll)
  assert.match(cover.value.image, /^data:image\/jpeg;base64,/)
  const missing = await tools.execute('get_cover', { trackId: 't2' }, null, approveAll)
  assert.equal(missing.value.cover, null)
})

test('truncateToolResult 截断超长结果', () => {
  const long = 'x'.repeat(50000)
  assert.ok(truncateToolResult(long).length < 25010)
  assert.ok(truncateToolResult({ a: long }).length < 25010)
})
