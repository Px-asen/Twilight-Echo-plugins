/**
 * Token usage and cost accounting, persisted monthly in the plugin data dir.
 * Prices are per million tokens as configured on each API profile.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export function createUsageTracker({ storagePath }) {
  const file = join(storagePath, 'usage.json')
  let writes = Promise.resolve()

  async function readAll() {
    try {
      const data = JSON.parse(await readFile(file, 'utf8'))
      if (data && typeof data === 'object' && Array.isArray(data.months)) return data
    } catch {
      /* fresh start */
    }
    return { months: [] }
  }

  async function writeAll(data) {
    await mkdir(storagePath, { recursive: true })
    const temp = `${file}.tmp`
    await writeFile(temp, JSON.stringify(data), 'utf8')
    await rename(temp, file)
  }

  async function recordOne({ profileId, model, usage, pricing }) {
    const month = new Date().toISOString().slice(0, 7)
    const data = await readAll()
    let bucket = data.months.find((entry) => entry.month === month)
    if (!bucket) {
      bucket = { month, calls: 0, inputTokens: 0, outputTokens: 0, cost: 0, byProfile: {} }
      data.months.push(bucket)
      data.months.sort((a, b) => b.month.localeCompare(a.month))
      data.months = data.months.slice(0, 24)
    }
    const inputTokens = Number(usage?.inputTokens) || 0
    const outputTokens = Number(usage?.outputTokens) || 0
    const cost =
      (inputTokens / 1_000_000) * (pricing?.inputPerMillion || 0) +
      (outputTokens / 1_000_000) * (pricing?.outputPerMillion || 0)
    bucket.calls += 1
    bucket.inputTokens += inputTokens
    bucket.outputTokens += outputTokens
    bucket.cost = Math.round((bucket.cost + cost) * 1e6) / 1e6
    const profileKey = profileId || 'default'
    const profileBucket = (bucket.byProfile[profileKey] ??= {
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      cost: 0,
      models: {}
    })
    profileBucket.calls += 1
    profileBucket.inputTokens += inputTokens
    profileBucket.outputTokens += outputTokens
    profileBucket.cost = Math.round((profileBucket.cost + cost) * 1e6) / 1e6
    const modelKey = model || 'unknown'
    const modelBucket = (profileBucket.models[modelKey] ??= { calls: 0, inputTokens: 0, outputTokens: 0 })
    modelBucket.calls += 1
    modelBucket.inputTokens += inputTokens
    modelBucket.outputTokens += outputTokens
    await writeAll(data)
    return { inputTokens, outputTokens, cost }
  }

  function record(entry) {
    const next = writes.catch(() => {}).then(() => recordOne(entry))
    writes = next
    return next
  }

  async function summary() {
    await writes.catch(() => {})
    const data = await readAll()
    const month = data.months[0] ?? {
      month: new Date().toISOString().slice(0, 7),
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      cost: 0,
      byProfile: {}
    }
    return { month: month.month, calls: month.calls, inputTokens: month.inputTokens, outputTokens: month.outputTokens, cost: month.cost, byProfile: month.byProfile }
  }

  return { record, summary }
}
