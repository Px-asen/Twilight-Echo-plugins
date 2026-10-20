export * from './lyricTypes.ts'
export * from './lyricParser.ts'
export { buildLyricLines } from './lyricLineBuilder.ts'
import type { LyricWord } from './lyricTypes.ts'

export function findActiveLyricIndex(
  lines: readonly { time: number | null }[],
  currentTime: number
): number {
  if (lines.length === 0 || !Number.isFinite(currentTime)) return -1

  let low = 0
  let high = lines.length - 1
  let activeIndex = -1

  while (low <= high) {
    const mid = Math.floor((low + high) / 2)
    const lineTime = lines[mid].time

    if (lineTime == null) {
      high = mid - 1
      continue
    }

    if (lineTime <= currentTime) {
      activeIndex = mid
      low = mid + 1
    } else {
      high = mid - 1
    }
  }

  return activeIndex
}

export function findActiveWordIndex(words: readonly LyricWord[], currentTime: number): number {
  if (!words.length || !Number.isFinite(currentTime)) return -1
  let activeIndex = -1
  for (let i = 0; i < words.length; i++) {
    const word = words[i]
    if (word.time <= currentTime) activeIndex = i
    else break
  }
  return activeIndex
}

/**
 * Return the left-to-right karaoke fill for a word.
 *
 * Word timestamps are absolute playback positions. YRC supplies an explicit
 * end time, while older enhanced LRC usually only supplies the next word's
 * start; accepting both keeps the renderer independent of the source format.
 */
export function getLyricWordProgress(
  word: LyricWord,
  nextWordTime: number | null | undefined,
  currentTime: number
): number {
  if (!Number.isFinite(word.time) || !Number.isFinite(currentTime)) return 0
  if (currentTime <= word.time) return 0

  const endTime = word.endTime ?? nextWordTime ?? null
  if (endTime == null || !Number.isFinite(endTime) || endTime <= word.time) return 1

  return Math.min(1, Math.max(0, (currentTime - word.time) / (endTime - word.time)))
}

export function hasLyricContent(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0
}
