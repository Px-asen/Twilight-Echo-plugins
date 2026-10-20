// Plugin adaptations (2026-10-18): XML declaration; relative end offsets use
// the parent start, and already-resolved auxiliary/background roots are not timed twice.
import { DOMParser, type Element, type Node } from '@xmldom/xmldom'
import type { LyricAuxiliaryLayer, LyricLine, LyricVoiceLayer, LyricWord } from './lyricTypes.ts'

export function isAmlTtml(value: string | null | undefined): boolean {
  return typeof value === 'string' && /^\s*(?:<\?xml[\s\S]*?\?>\s*)?<tt(?:\s|>)/i.test(value)
}

function attr(element: Element, name: string): string | null {
  return element.getAttribute(name) || element.getAttribute(`ttm:${name}`) || null
}

function localName(node: Node): string {
  return (
    (node as Node & { localName?: string }).localName ||
    node.nodeName.split(':').pop() ||
    ''
  ).toLowerCase()
}

function roleOf(element: Element): string | null {
  return attr(element, 'role')?.toLowerCase() ?? null
}

function parseTime(value: string | null | undefined, inherited = 0): number | null {
  if (!value) return inherited
  const raw = value.trim()
  if (!raw) return inherited
  // AMLL's historical TTML files commonly use bare decimal seconds instead
  // of the unit-suffixed TTML offset form (`0.115`, `2.813`). Those values are
  // absolute timestamps, matching the clock-form expressions below.
  const numeric = /^(\d+(?:\.\d+)?)$/.exec(raw)
  if (numeric) {
    const result = Number(numeric[1])
    return Number.isFinite(result) ? result : null
  }
  const clock = /^(?:(\d+):)?(\d{1,2}):(\d{2})(?:\.(\d+))?$/.exec(raw)
  if (clock) {
    const hours = Number(clock[1] ?? 0)
    const minutes = Number(clock[2])
    const seconds = Number(clock[3])
    const fraction = clock[4] ? Number(`0.${clock[4]}`) : 0
    const result = hours * 3600 + minutes * 60 + seconds + fraction
    return Number.isFinite(result) ? result : null
  }
  const offset = /^(\d+(?:\.\d+)?)(h|m|s|ms|f|t)$/.exec(raw)
  if (offset) {
    const amount = Number(offset[1])
    const unit = offset[2]
    const seconds =
      unit === 'h'
        ? amount * 3600
        : unit === 'm'
          ? amount * 60
          : unit === 'ms'
            ? amount / 1000
            : amount
    return Number.isFinite(seconds) ? inherited + seconds : null
  }
  return null
}

function parseEnd(element: Element, parentStart: number, parentEnd: number | null): number | null {
  const value = element.getAttribute('end')
  return value ? parseTime(value, parentStart) : parentEnd
}

function textParts(node: Node): string[] {
  if (node.nodeType === 3) return [node.nodeValue ?? '']
  if (node.nodeType !== 1) return []
  const parts: string[] = []
  for (let child = node.firstChild; child; child = child.nextSibling)
    parts.push(...textParts(child))
  return parts
}

function shouldInsertTtmlSpace(left: string, right: string): boolean {
  if (!left || !right || /\s$/.test(left) || /^\s/.test(right)) return false

  const leftChar = left[left.length - 1]
  const rightChar = right[0]
  const leftWordChar = /[A-Za-z0-9]/.test(leftChar)
  const rightWordChar = /[A-Za-z0-9]/.test(rightChar)
  if (!rightWordChar) return false

  // Most malformed TTML only loses the boundary between two word spans.
  if (leftWordChar) return true

  // Punctuation belongs to the previous word, but the following English word
  // still needs its normal separating space.
  return /[,.;:!?\u2014)]/.test(leftChar)
}

/**
 * AMLL's current files keep at most one explicit space between English words,
 * but old and third-party TTML often omit the boundary between adjacent spans.
 * Reconstruct only unambiguous Latin word boundaries; CJK and punctuation
 * joins remain untouched.
 */
function joinTtmlTextParts(parts: readonly string[], trim = true): string {
  let result = ''
  const hasExplicitWhitespace = parts.some((part) => /\s/.test(part))
  for (const rawPart of parts) {
    const part = rawPart.replace(/\s+/g, ' ')
    if (!part) continue
    if (!hasExplicitWhitespace && result && shouldInsertTtmlSpace(result, part)) result += ' '
    result += part
  }
  return trim ? result.replace(/\s+/g, ' ').trim() : result
}

function textContent(node: Node): string {
  return joinTtmlTextParts(textParts(node))
}

function wordTextContent(node: Node): string {
  return joinTtmlTextParts(textParts(node), false)
}

function visibleTextParts(node: Node): string[] {
  if (node.nodeType === 3) return [node.nodeValue ?? '']
  if (node.nodeType !== 1) return []
  const element = node as Element
  const role = roleOf(element)
  if (role === 'x-translation' || role === 'x-roman') return []
  const parts: string[] = []
  for (let child = element.firstChild; child; child = child.nextSibling)
    parts.push(...visibleTextParts(child))
  return parts
}

function visibleTextContent(node: Node): string {
  return joinTtmlTextParts(visibleTextParts(node))
}

function insertTtmlWordSpaces(words: readonly LyricWord[]): LyricWord[] {
  const ordered = [...words].sort((a, b) => a.time - b.time)
  // A whitespace-only word means the source already described its boundaries
  // explicitly. Keep those boundaries and do not guess at syllable joins such
  // as `win` + `ter` or `ne` + `ver` in the same line.
  if (ordered.some((word) => /\s/.test(word.text))) return ordered

  const result: LyricWord[] = []
  let previous: LyricWord | null = null
  for (const word of ordered) {
    if (previous && shouldInsertTtmlSpace(previous.text, word.text)) {
      const time = previous.endTime ?? word.time
      result.push({
        time,
        endTime: word.time > time ? word.time : time,
        text: ' '
      })
    }
    result.push(word)
    previous = word
  }
  return result
}

function safeInterval(
  start: number | null,
  end: number | null
): { time: number; endTime: number | null } | null {
  if (start == null || !Number.isFinite(start)) return null
  if (end != null && (!Number.isFinite(end) || end < start)) return null
  return { time: start, endTime: end }
}

function collectWords(
  node: Node,
  inheritedStart: number,
  inheritedEnd: number | null
): LyricWord[] {
  const words: LyricWord[] = []
  let pendingWhitespace = false
  const visit = (current: Node, start: number, end: number | null, root = false): void => {
    if (current.nodeType === 3) {
      if (/\s/.test(current.nodeValue ?? '') && !(current.nodeValue ?? '').trim())
        pendingWhitespace = true
      return
    }
    if (current.nodeType !== 1) {
      for (let child = current.firstChild; child; child = child.nextSibling)
        visit(child, start, end)
      return
    }
    const element = current as Element
    const role = roleOf(element)
    if (!root && (role === 'x-translation' || role === 'x-roman' || role === 'x-bg')) return
    const local = localName(element)
    const ownStart = root ? start : parseTime(element.getAttribute('begin'), start)
    const ownEnd = root ? end : parseEnd(element, start, end)
    if (!root && local === 'span' && ownStart != null && textContent(element)) {
      const interval = safeInterval(ownStart, ownEnd)
      if (interval) {
        const word = {
          time: interval.time,
          endTime: interval.endTime,
          text: wordTextContent(element)
        }
        if (
          pendingWhitespace &&
          words.length > 0 &&
          !/\s$/.test(words[words.length - 1].text) &&
          !/^\s/.test(word.text)
        ) {
          const previous = words[words.length - 1]
          const time = previous.endTime ?? word.time
          words.push({
            time,
            endTime: word.time > time ? word.time : time,
            text: ' '
          })
        }
        words.push(word)
        pendingWhitespace = false
      }
      return
    }
    for (let child = element.firstChild; child; child = child.nextSibling)
      visit(child, ownStart ?? start, ownEnd ?? end)
  }
  visit(node, inheritedStart, inheritedEnd, true)
  // A directly timed auxiliary/background phrase remains one timed word when
  // it has no nested word spans. Its root interval has already been resolved.
  if (!words.length && node.nodeType === 1 && localName(node) === 'span' && textContent(node)) {
    words.push({ time: inheritedStart, endTime: inheritedEnd, text: wordTextContent(node) })
  }
  return insertTtmlWordSpaces(words)
}

function makeAuxiliary(
  node: Element,
  start: number,
  end: number | null
): LyricAuxiliaryLayer | null {
  const ownStart = parseTime(node.getAttribute('begin'), start)
  const ownEnd = parseEnd(node, start, end)
  const interval = safeInterval(ownStart, ownEnd)
  if (!interval) return null
  const text = textContent(node)
  if (!text) return null
  const words = collectWords(node, interval.time, interval.endTime)
  return { time: interval.time, text, ...(words.length ? { words } : {}) }
}

function voiceKey(
  index: number,
  agent: string | null,
  role: LyricVoiceLayer['role'],
  time: number
): string {
  return `amll:${index}:${encodeURIComponent(agent ?? 'default')}:${role}:${Math.round(time * 1000)}`
}

interface ParsedVoice {
  sourceGroup: number
  agent: string | null
  role: LyricVoiceLayer['role']
  start: number
  end: number | null
  text: string
  words: LyricWord[]
  translation: LyricAuxiliaryLayer | null
  romanization: LyricAuxiliaryLayer | null
}

function parsePrimaryChildren(
  node: Element,
  start: number,
  end: number | null,
  headAuxiliary:
    | { translation: LyricAuxiliaryLayer | null; romanization: LyricAuxiliaryLayer | null }
    | undefined,
  agent: string | null,
  sourceGroup: number
): ParsedVoice[] {
  const primaryParts: string[] = []
  const words: LyricWord[] = []
  let pendingWhitespace = false
  let translation: LyricAuxiliaryLayer | null = null
  let romanization: LyricAuxiliaryLayer | null = null
  const backgrounds: ParsedVoice[] = []
  const visit = (current: Node, currentStart: number, currentEnd: number | null): void => {
    if (current.nodeType === 3) {
      const value = current.nodeValue ?? ''
      const normalized = value.replace(/\s+/g, ' ')
      if (value.trim()) primaryParts.push(normalized)
      else if (normalized) {
        primaryParts.push(normalized)
        pendingWhitespace = true
      }
      return
    }
    if (current.nodeType !== 1) return
    const element = current as Element
    const role = roleOf(element)
    if (role === 'x-translation' || role === 'x-roman') {
      const auxiliary = makeAuxiliary(element, currentStart, currentEnd)
      if (role === 'x-translation') translation = auxiliary
      else romanization = auxiliary
      return
    }
    if (role === 'x-bg') {
      const bgStart = parseTime(element.getAttribute('begin'), currentStart)
      const bgEnd = parseEnd(element, currentStart, currentEnd)
      const interval = safeInterval(bgStart, bgEnd)
      if (interval) {
        const bgWords = collectWords(element, interval.time, interval.endTime)
        const bgText = visibleTextContent(element).replace(/\s+/g, ' ').trim()
        if (bgText) {
          let bgTranslation: LyricAuxiliaryLayer | null = null
          let bgRomanization: LyricAuxiliaryLayer | null = null
          for (let child = element.firstChild; child; child = child.nextSibling) {
            if (child.nodeType !== 1) continue
            const childRole = roleOf(child as Element)
            if (childRole === 'x-translation')
              bgTranslation = makeAuxiliary(child as Element, interval.time, interval.endTime)
            if (childRole === 'x-roman')
              bgRomanization = makeAuxiliary(child as Element, interval.time, interval.endTime)
          }
          backgrounds.push({
            sourceGroup,
            agent,
            role: 'background',
            start: interval.time,
            end: interval.endTime,
            text: bgText,
            words: bgWords,
            translation: bgTranslation,
            romanization: bgRomanization
          })
        }
      }
      return
    }
    const ownStart = parseTime(element.getAttribute('begin'), currentStart)
    const ownEnd = parseEnd(element, currentStart, currentEnd)
    if (localName(element) === 'span' && ownStart != null && textContent(element)) {
      const interval = safeInterval(ownStart, ownEnd)
      if (interval) {
        const wordText = wordTextContent(element)
        if (
          pendingWhitespace &&
          words.length > 0 &&
          !/\s$/.test(words[words.length - 1].text) &&
          !/^\s/.test(wordText)
        ) {
          const previous = words[words.length - 1]
          const time = previous.endTime ?? interval.time
          words.push({
            time,
            endTime: interval.time > time ? interval.time : time,
            text: ' '
          })
        }
        words.push({ time: interval.time, endTime: interval.endTime, text: wordText })
        primaryParts.push(wordText)
        pendingWhitespace = false
      }
      return
    }
    for (let child = element.firstChild; child; child = child.nextSibling)
      visit(child, ownStart ?? currentStart, ownEnd ?? currentEnd)
  }
  for (let child = node.firstChild; child; child = child.nextSibling) visit(child, start, end)
  const primaryText = joinTtmlTextParts(primaryParts)
  const primary = primaryText
    ? [
        {
          sourceGroup,
          agent,
          role: 'lead' as const,
          start,
          end,
          text: primaryText,
          words: insertTtmlWordSpaces(words),
          translation: translation ?? headAuxiliary?.translation ?? null,
          romanization: romanization ?? headAuxiliary?.romanization ?? null
        }
      ]
    : []
  return [...primary, ...backgrounds]
}

function overlap(left: ParsedVoice, right: ParsedVoice): boolean {
  const leftEnd = left.end ?? Number.POSITIVE_INFINITY
  const rightEnd = right.end ?? Number.POSITIVE_INFINITY
  return left.start < rightEnd && right.start < leftEnd
}

const DUET_ONSET_TOLERANCE_SECONDS = 0.2

function sharesDuetOnset(left: ParsedVoice, right: ParsedVoice): boolean {
  return (
    left.role === 'lead' &&
    right.role === 'lead' &&
    left.agent != null &&
    right.agent != null &&
    left.agent !== right.agent &&
    overlap(left, right) &&
    Math.abs(left.start - right.start) <= DUET_ONSET_TOLERANCE_SECONDS
  )
}

function parseDocument(input: string): ParsedVoice[] {
  if (!isAmlTtml(input) || /<!DOCTYPE|<!ENTITY/i.test(input)) return []
  let parserError = false
  const document = new DOMParser({
    onError: (level) => {
      if (level !== 'warning') parserError = true
    }
  }).parseFromString(input, 'text/xml')
  if (parserError || !document.documentElement || localName(document.documentElement) !== 'tt')
    return []
  const voices: ParsedVoice[] = []
  let sourceGroup = 0
  const headAuxiliary = new Map<
    string,
    { translation: LyricAuxiliaryLayer | null; romanization: LyricAuxiliaryLayer | null }
  >()
  const head = document.getElementsByTagName('head')[0]
  if (head) {
    const scanHead = (node: Node): void => {
      if (node.nodeType === 1) {
        const element = node as Element
        const name = localName(element)
        const key =
          element.getAttribute('itunes:key') ||
          element.getAttribute('key') ||
          element.getAttribute('id') ||
          element.getAttribute('xml:id')
        const role = roleOf(element) ?? ''
        const kind = `${name} ${role}`
        if (key && /(translation|translat|roman|translit)/i.test(kind) && textContent(element)) {
          const current = headAuxiliary.get(key) ?? { translation: null, romanization: null }
          const auxiliary: LyricAuxiliaryLayer = { time: null, text: textContent(element) }
          if (/roman|translit/i.test(kind)) current.romanization = auxiliary
          else current.translation = auxiliary
          headAuxiliary.set(key, current)
        }
      }
      for (let child = node.firstChild; child; child = child.nextSibling) scanHead(child)
    }
    scanHead(head)
  }
  const visit = (node: Node): void => {
    if (node.nodeType === 1 && localName(node) === 'p') {
      const element = node as Element
      const currentSourceGroup = sourceGroup++
      const start = parseTime(element.getAttribute('begin'))
      const end = parseEnd(element, 0, null)
      const interval = safeInterval(start, end)
      if (interval) {
        const agent = attr(element, 'agent')
        const key = element.getAttribute('itunes:key') || element.getAttribute('key') || ''
        const auxiliary = headAuxiliary.get(key)
        if (auxiliary) {
          for (const layer of ['translation', 'romanization'] as const) {
            const value = auxiliary[layer]
            if (value) auxiliary[layer] = { ...value, time: interval.time }
          }
        }
        voices.push(
          ...parsePrimaryChildren(
            element,
            interval.time,
            interval.endTime,
            auxiliary,
            agent,
            currentSourceGroup
          )
        )
      }
    }
    for (let child = node.firstChild; child; child = child.nextSibling) visit(child)
  }
  visit(document.documentElement)
  return voices
}

export function parseAmlTtml(input: string): LyricLine[] {
  const parsed = parseDocument(input)
  if (!parsed.length) return []
  const leadAgents = [
    ...new Set(
      parsed
        .filter((voice) => voice.role === 'lead' && voice.agent != null)
        .map((voice) => voice.agent as string)
    )
  ]
  const agentLanes = new Map<string, LyricVoiceLayer['lane']>()
  if (leadAgents.length > 1) {
    leadAgents.forEach((agent, index) => {
      agentLanes.set(agent, index % 2 === 0 ? 'start' : 'end')
    })
  }
  const rows: Array<{ time: number; end: number | null; voices: ParsedVoice[] }> = []
  for (const voice of parsed) {
    const row = rows.find((candidate) =>
      candidate.voices.some((existing) =>
        voice.role === 'background'
          ? existing.sourceGroup === voice.sourceGroup
          : sharesDuetOnset(existing, voice)
      )
    )
    if (row) {
      row.voices.push(voice)
      row.time = Math.min(row.time, voice.start)
      row.end = row.end == null || voice.end == null ? null : Math.max(row.end, voice.end)
    } else rows.push({ time: voice.start, end: voice.end, voices: [voice] })
  }
  rows.sort((a, b) => a.time - b.time)
  return rows.map((row, rowIndex) => {
    const leadVoices = row.voices.filter((voice) => voice.role === 'lead')
    const hasDuet =
      leadVoices.length > 1 &&
      leadVoices.some((voice, i) =>
        leadVoices.some((other, j) => i !== j && sharesDuetOnset(voice, other))
      )
    let leadIndex = 0
    const voices: LyricVoiceLayer[] = row.voices.map((voice, voiceIndex) => {
      const agentLane = voice.agent ? agentLanes.get(voice.agent) : undefined
      const sourceLeadLane = row.voices
        .filter(
          (candidate) => candidate.sourceGroup === voice.sourceGroup && candidate.role === 'lead'
        )
        .map((candidate) => (candidate.agent ? agentLanes.get(candidate.agent) : undefined))
        .find((candidate): candidate is LyricVoiceLayer['lane'] => candidate != null)
      const lane =
        voice.role === 'background'
          ? (sourceLeadLane ?? agentLane ?? 'center')
          : hasDuet
            ? (agentLane ?? (leadIndex++ % 2 === 0 ? 'start' : 'end'))
            : (agentLane ?? 'center')
      return {
        voiceKey: voiceKey(rowIndex * 10 + voiceIndex, voice.agent, voice.role, voice.start),
        role: voice.role,
        lane,
        ...(voice.agent ? { speaker: voice.agent } : {}),
        time: voice.start,
        ...(voice.end != null ? { endTime: voice.end } : {}),
        text: voice.text,
        ...(voice.words.length ? { words: voice.words } : {}),
        ...(voice.translation ? { translation: voice.translation } : {}),
        ...(voice.romanization ? { romanization: voice.romanization } : {})
      }
    })
    const visibleLead = voices.find((voice) => voice.role === 'lead') ?? voices[0]
    const lineTranslation = voices.some((voice) => voice.translation) ? null : null
    const lineRomanization = voices.some((voice) => voice.romanization) ? null : null
    return {
      time: row.time,
      text: voices
        .map((voice) => voice.text)
        .filter(Boolean)
        .join(' · '),
      translation: lineTranslation,
      romanization: lineRomanization,
      timed: true,
      words: voices.length === 1 ? visibleLead.words : undefined,
      rowKey: `amll:${rowIndex}:${Math.round(row.time * 1000)}`,
      voices
    }
  })
}
