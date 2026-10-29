import { abortable } from './runtime.mjs'

/** One implementation for bounded model tools and complete local workflows. */
export async function scanLibrary({ library, kind, signal, maxPages = Infinity, onProgress = () => {}, onPage = () => {} }) {
  if (!['quality', 'duplicates'].includes(kind)) throw new Error('未知检查类型')
  const groups = new Map()
  const stats = { total: 0, formats: {}, sampleRates: {}, bitDepths: {}, missingGenre: 0, missingCover: 0, missingBpm: 0, lossless: 0, hiRes: 0 }
  let libraryTotal = 0, firstRevision, stale = false, exhausted = false
  const snapshot = () => {
    const common = { scanned: stats.total, libraryTotal, libraryRevision: firstRevision, complete: exhausted && !stale && !signal?.aborted, stale, cancelled: signal?.aborted === true }
    if (kind === 'quality') return {
      ...stats, ...common,
      coverage: stats.total ? { genre: 1 - stats.missingGenre / stats.total, cover: 1 - stats.missingCover / stats.total, bpm: 1 - stats.missingBpm / stats.total } : null
    }
    const duplicateGroups = []
    for (const group of groups.values()) {
      for (const cluster of clusterByDuration(group)) {
        if (cluster.length > 1) duplicateGroups.push(cluster)
      }
    }
    duplicateGroups.sort((a, b) => b.length - a.length)
    return {
      ...common, totalGroups: duplicateGroups.length, truncated: duplicateGroups.length > 40 || duplicateGroups.some(cluster => cluster.length > 20),
      duplicateGroups: duplicateGroups.slice(0, 40).map(cluster => ({ count: cluster.length, keep: compactTrack(cluster[0]), duplicates: cluster.slice(1, 20).map(compactTrack) }))
    }
  }
  for (let pageIndex = 0; pageIndex < maxPages; pageIndex++) {
    if (signal?.aborted) break
    let page
    try {
      page = await abortable(library.queryTracks({ offset: pageIndex * 200, limit: 200, sort: kind === 'quality' ? 'insertion' : 'title', direction: 'asc' }), signal)
    } catch (error) {
      if (signal?.aborted) break
      throw error
    }
    libraryTotal = Number(page.total) || 0
    onPage(page)
    if (pageIndex === 0) firstRevision = page.revision
    else if (firstRevision !== undefined && page.revision !== firstRevision) stale = true
    const tracks = page.tracks ?? []
    for (const record of tracks) {
      stats.total++
      if (kind === 'duplicates') {
        const key = identityKey(record)
        const group = groups.get(key) ?? []
        group.push(record)
        groups.set(key, group)
      } else {
        const format = String(record.format ?? '未知').toUpperCase()
        bump(stats.formats, format)
        bump(stats.sampleRates, String(Number(record.sampleRate) || 0))
        if (record.bitDepth) bump(stats.bitDepths, String(record.bitDepth))
        if (!String(record.genre ?? '').trim()) stats.missingGenre++
        if (!record.cover) stats.missingCover++
        if (!record.bpm && !record.bpmAnalysis?.bpm) stats.missingBpm++
        if (['FLAC', 'WAV', 'ALAC', 'APE', 'DSF', 'DFF', 'WV'].includes(format)) stats.lossless++
        if (Number(record.sampleRate) > 48000) stats.hiRes++
      }
    }
    exhausted = tracks.length === 0 || (pageIndex + 1) * 200 >= libraryTotal
    onProgress({ scanned: stats.total, libraryTotal, stale })
    if (exhausted || stale) break
    // Give cancellation and RPC messages a turn even with a fast local database.
    await new Promise(resolve => setTimeout(resolve, 0))
  }
  return snapshot()
}

function bump(map, key) { map[key] = (map[key] ?? 0) + 1 }
function normalizeText(value) {
  return String(value ?? '').toLowerCase().replace(/\(.*?\)|（.*?）|\[.*?\]|【.*?】/g, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}
function identityKey(record) { return `${normalizeText(record.title)}|${normalizeText(String(record.artist ?? '').split('/')[0])}` }
function clusterByDuration(records) {
  const sorted = [...records].sort((a, b) => (Number(a.duration) || 0) - (Number(b.duration) || 0))
  const clusters = []
  let current = []
  for (const record of sorted) {
    if (current.length && (Number(record.duration) || 0) - (Number(current.at(-1).duration) || 0) > 3) {
      if (current.length > 1) clusters.push(current)
      current = []
    }
    current.push(record)
  }
  if (current.length > 1) clusters.push(current)
  return clusters
}
export function compactTrack(record) {
  const year = Number(String(record.releaseDate ?? '').slice(0, 4))
  return { id: record.id, title: record.title ?? '', artist: record.artist ?? '', album: record.album ?? '', genre: record.genre ?? '', year: year > 1000 ? year : undefined,
    duration: Math.round(Number(record.duration) || 0), format: record.format ?? '', sampleRate: Number(record.sampleRate) || undefined, bitDepth: Number(record.bitDepth) || undefined, bpm: Number(record.bpm) || record.bpmAnalysis?.bpm || undefined }
}

export function reportSummary(kind, result) {
  const name = kind === 'quality' ? '曲库体检' : '重复检查'
  const status = result.stale ? '曲库已变化，结果已过期' : result.cancelled ? '已停止，部分结果' : result.complete ? '完整检查' : '部分检查'
  const summary = `${name}：${status}，扫描 ${result.scanned} / ${result.libraryTotal} 首。${result.freshnessUnknown ? '暂时无法核对曲库是否变化。' : ''}`
  return kind === 'quality'
    ? `${summary}\n缺失流派 ${result.missingGenre} 首，封面 ${result.missingCover} 首，BPM ${result.missingBpm} 首。无损 ${result.lossless} 首，高采样率 ${result.hiRes} 首。\n格式分布：${JSON.stringify(result.formats)}\n采样率分布：${JSON.stringify(result.sampleRates)}\n位深分布：${JSON.stringify(result.bitDepths)}`
    : `${summary}\n发现 ${result.totalGroups} 组疑似重复，展示前 ${result.duplicateGroups.length} 组。候选顺序不代表保留建议。\n${JSON.stringify(result.duplicateGroups)}`
}
