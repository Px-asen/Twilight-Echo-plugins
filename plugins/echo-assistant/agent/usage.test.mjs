import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createUsageTracker } from './usage.mjs'

test('多个会话并发记账不丢调用或 token，汇总包含已排队写入', async () => {
  const storagePath = await mkdtemp(join(tmpdir(), 'echo-usage-'))
  try {
    const usage = createUsageTracker({ storagePath })
    const writes = Array.from({ length: 16 }, (_, i) => usage.record({ profileId: `p${i % 2}`, model: 'test', usage: { inputTokens: 100, outputTokens: 50 }, pricing: { inputPerMillion: 1, outputPerMillion: 2 } }))
    const summary = await usage.summary()
    await Promise.all(writes)
    assert.equal(summary.calls, 16)
    assert.equal(summary.inputTokens, 1600)
    assert.equal(summary.outputTokens, 800)
    assert.equal(summary.cost, 0.0032)
    assert.equal(summary.byProfile.p0.calls, 8)
    assert.equal(summary.byProfile.p1.calls, 8)
  } finally { await rm(storagePath, { recursive: true, force: true }) }
})
