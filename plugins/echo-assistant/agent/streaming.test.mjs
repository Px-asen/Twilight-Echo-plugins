import test from 'node:test'
import assert from 'node:assert/strict'
import { createProvider, createSseParser } from './providers.mjs'
import { scanLibrary } from './scans.mjs'

function response(events, { close = true, cancelled = () => {} } = {}) {
  return new Response(new ReadableStream({
    start(controller) {
      for (const event of events) controller.enqueue(new TextEncoder().encode(`data: ${typeof event === 'string' ? event : JSON.stringify(event)}\r\n\r\n`))
      if (close) controller.close()
    }, cancel: cancelled
  }))
}
const base = { baseUrl: 'http://localhost/v1', model: 'test', apiKey: '', temperature: .6 }
for (const [protocol, events] of [
  ['openai-chat', [{ choices: [{ delta: { content: '答案' } }] }, { usage: { prompt_tokens: 3, completion_tokens: 4 }, choices: [] }, '[DONE]']],
  ['openai-responses', [{ type: 'response.output_text.delta', delta: '答案' }, { type: 'response.completed', response: { usage: { input_tokens: 3, output_tokens: 4 } } }]],
  ['anthropic', [{ type: 'message_start', message: { usage: { input_tokens: 3 } } }, { type: 'content_block_delta', delta: { type: 'text_delta', text: '答案' } }, { type: 'message_delta', usage: { output_tokens: 4 } }, { type: 'message_stop' }]]
]) test(`${protocol} 结束事件主动释放未关闭的连接，保留用量`, async () => {
  const original = globalThis.fetch
  let cancelled = false
  globalThis.fetch = async () => response(events, { close: false, cancelled: () => cancelled = true })
  try {
    const result = await createProvider({ ...base, protocol })({ system: 'sys', messages: [], tools: [] })
    assert.equal(result.text, '答案')
    assert.deepEqual(result.usage, { inputTokens: 3, outputTokens: 4 })
    assert.equal(cancelled, true)
  } finally { globalThis.fetch = original }
})

test('SSE 支持跨块 CRLF、多行 data、EOF 尾事件', () => {
  const parser = createSseParser()
  assert.deepEqual(parser.feed('data: {"a":\r'), [])
  assert.deepEqual(parser.feed('\ndata: 1}\r\n\r'), [])
  assert.deepEqual(parser.feed('\ndata: [DONE]'), [{ json: { a: 1 } }])
  assert.deepEqual(parser.finish(), [{ done: true }])
})

test('流内错误、Responses incomplete/failed 均转为失败而非空回复', async () => {
  const original = globalThis.fetch
  try {
    for (const [protocol, event] of [
      ['openai-chat', { error: { message: '余额不足' } }],
      ['anthropic', { type: 'error', error: { message: '服务过载' } }],
      ['openai-responses', { type: 'response.failed', response: { error: { message: '服务失败' } } }],
      ['openai-responses', { type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' } } }]
    ]) {
      globalThis.fetch = async () => response([event], { close: false })
      await assert.rejects(() => createProvider({ ...base, protocol })({ system: '', messages: [] }), /余额不足|过载|服务失败|max_output_tokens/)
    }
  } finally { globalThis.fetch = original }
})

test('网络忽略 abort 时仍可结束，空闲超时可观测，用户取消释放 reader', async () => {
  const original = globalThis.fetch
  const keepAlive = setTimeout(() => {}, 1000)
  try {
    globalThis.fetch = () => new Promise(() => {})
    await assert.rejects(() => createProvider({ ...base, protocol: 'openai-chat' }, { idleTimeoutMs: 10 })({ system: '', messages: [] }), /超时/)
    const controller = new AbortController()
    let readCancelled = false
    globalThis.fetch = async () => response([], { close: false, cancelled: () => readCancelled = true })
    const running = createProvider({ ...base, protocol: 'openai-chat' })({ system: '', messages: [], signal: controller.signal })
    await new Promise(resolve => setTimeout(resolve, 5)); controller.abort(new Error('测试停止'))
    await assert.rejects(running, /测试停止/)
    await new Promise(resolve => setTimeout(resolve, 5)); assert.equal(readCancelled, true)
  } finally { clearTimeout(keepAlive); globalThis.fetch = original }
})

test('三种协议的心跳、空 JSON 和无关事件不会延长无有效响应超时', async () => {
  const original = globalThis.fetch
  let timer
  try {
    for (const protocol of ['openai-chat', 'openai-responses', 'anthropic']) {
      let readCancelled = false
      globalThis.fetch = async () => new Response(new ReadableStream({
        start(controller) {
          timer = setInterval(() => controller.enqueue(new TextEncoder().encode('data: {"type":"ping"}\r\n\r\ndata: {}\r\n\r\ndata: {"choices":[]}\r\n\r\ndata: {"type":"heartbeat"}\r\n\r\n')), 5)
        },
        cancel() { readCancelled = true; clearInterval(timer) }
      }))
      await assert.rejects(() => createProvider({ ...base, protocol }, { idleTimeoutMs: 30 })({ system: '', messages: [], signal: AbortSignal.timeout(500) }), /连续 120 秒没有有效响应/)
      await new Promise(resolve => setTimeout(resolve, 5))
      assert.equal(readCancelled, true)
    }
  } finally { clearInterval(timer); globalThis.fetch = original }
})

test('Responses 历史中的文本与多个工具调用展开为平坦 input', async () => {
  const original = globalThis.fetch
  let input
  globalThis.fetch = async (_url, init) => { input = JSON.parse(init.body).input; return response([{ type: 'response.completed' }]) }
  try {
    await createProvider({ ...base, protocol: 'openai-responses' })({ system: '', messages: [{ role: 'assistant', content: [{ type: 'text', text: '我来检查' }], toolCalls: [{ id: 'a', name: 'query_library', arguments: '{}' }, { id: 'b', name: 'get_app_settings', arguments: '{}' }] }] })
    assert.equal(input.length, 3); assert.ok(input.every(item => !Array.isArray(item)))
  } finally { globalThis.fetch = original }
})

test('检查空曲库、抽样上限与扫描途中 revision 改变', async () => {
  const empty = await scanLibrary({ kind: 'quality', library: { queryTracks: async () => ({ tracks: [], total: 0, revision: 1 }) } })
  assert.equal(empty.complete, true); assert.equal(empty.coverage, null)
  const library = { queryTracks: async ({ offset }) => ({ total: 1000, revision: offset ? 2 : 1, tracks: Array.from({ length: 200 }, (_, i) => ({ id: `${offset + i}`, title: 'Song', artist: 'A', duration: 100 })) }) }
  const bounded = await scanLibrary({ library, kind: 'quality', maxPages: 1 })
  assert.equal(bounded.scanned, 200); assert.equal(bounded.total, 200); assert.equal(bounded.libraryTotal, 1000); assert.equal(bounded.complete, false)
  const stale = await scanLibrary({ library, kind: 'duplicates' })
  assert.equal(stale.stale, true); assert.equal(stale.complete, false); assert.equal(stale.scanned, 400)
})

test('重复报告准确标注组数和组内截断，不把候选当保留建议', async () => {
  const tracks = Array.from({ length: 105 }, (_, i) => ({ id: `${i}`, title: i < 25 ? 'same' : `Song ${Math.floor((i - 25) / 2)}`, artist: 'A', duration: 100 }))
  const result = await scanLibrary({ kind: 'duplicates', library: { queryTracks: async () => ({ tracks, total: tracks.length }) } })
  assert.equal(result.totalGroups, 41); assert.equal(result.duplicateGroups.length, 40); assert.equal(result.truncated, true)
  assert.equal(result.duplicateGroups[0].count, 25); assert.equal(result.duplicateGroups[0].duplicates.length, 19)
})
