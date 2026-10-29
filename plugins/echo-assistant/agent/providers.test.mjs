import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createProvider,
  normalizeProfile,
  maskedProfile,
  createSseParser,
  safeParseArguments,
  listModels
} from './providers.mjs'

function sseResponse(events) {
  const body = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder()
      for (const event of events) {
        const payload =
          typeof event === 'string' ? event : `data: ${JSON.stringify(event)}\n\n`
        controller.enqueue(encoder.encode(payload))
      }
      controller.close()
    }
  })
  return { ok: true, body }
}

/** OpenAI splits tool-call arguments across chunks; fragments avoid quote soup. */
const CHAT_ARGS_FIRST = JSON.stringify({ search: 'j' }).slice(0, 5)
const CHAT_ARGS_REST = JSON.stringify({ search: 'j' }).slice(5)

const profile = normalizeProfile({
  label: '测试',
  protocol: 'openai-chat',
  baseUrl: 'https://api.example.com/v1',
  apiKey: 'sk-test-1234567890',
  model: 'gpt-test'
})

test('normalizeProfile 校验必填项并规范 baseUrl', () => {
  assert.equal(profile.baseUrl, 'https://api.example.com/v1')
  assert.throws(() => normalizeProfile({ protocol: 'openai-chat', model: 'm' }), /API Key/)
  assert.throws(() => normalizeProfile({ protocol: 'openai-chat', apiKey: 'k', model: '' }), /模型/)
  const local = normalizeProfile({
    protocol: 'openai-chat',
    baseUrl: 'http://127.0.0.1:11434/v1/',
    model: 'llama3'
  })
  assert.equal(local.baseUrl, 'http://127.0.0.1:11434/v1')
  assert.equal(local.apiKey, '')
})

test('maskedProfile 不泄露明文 key', () => {
  const masked = maskedProfile(profile)
  assert.ok(masked.apiKey.includes('****'))
  assert.ok(!masked.apiKey.includes('1234567890'))
})

test('openai-chat 构造请求体并解析流式工具调用', async () => {
  let captured
  const fetchMock = async (url, init) => {
    captured = { url, body: JSON.parse(init.body) }
    return sseResponse([
      { choices: [{ delta: { content: '你好' } }] },
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: 'call_1', function: { name: 'query_lib', arguments: '{"sea' } }
              ]
            }
          }
        ]
      },
      {
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, function: { arguments: 'rch": "j"}' }}]
            }
          }
        ]
      },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 11, completion_tokens: 7 } }
    ])
  }
  const originalFetch = globalThis.fetch
  globalThis.fetch = fetchMock
  try {
    const provider = createProvider(profile)
    const deltas = []
    const result = await provider({
      system: 'sys',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'image', dataUrl: 'data:image/png;base64,AAA' }] }
      ],
      tools: [{ name: 'query_lib', description: 'd', parameters: { type: 'object' } }],
      onDelta: (text) => deltas.push(text)
    })
    assert.equal(captured.url, 'https://api.example.com/v1/chat/completions')
    assert.equal(captured.body.model, 'gpt-test')
    assert.equal(captured.body.messages[0].role, 'system')
    const userMessage = captured.body.messages[1]
    assert.equal(userMessage.content[1].type, 'image_url')
    assert.deepEqual(deltas, ['你好'])
    assert.equal(result.text, '你好')
    assert.equal(result.toolCalls.length, 1)
    assert.equal(result.toolCalls[0].id, 'call_1')
    assert.deepEqual(JSON.parse(result.toolCalls[0].arguments), { search: 'j' })
    assert.deepEqual(result.usage, { inputTokens: 11, outputTokens: 7 })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('openai-responses 解析 Responses API 事件流', async () => {
  let captured
  const fetchMock = async (url, init) => {
    captured = { url, body: JSON.parse(init.body) }
    return sseResponse([
      { type: 'response.output_text.delta', delta: '答案' },
      {
        type: 'response.output_item.done',
        item: { type: 'function_call', id: 'item_1', call_id: 'call_9', name: 'play', arguments: '{"ids":["a"]}' }
      },
      {
        type: 'response.completed',
        response: { usage: { input_tokens: 5, output_tokens: 6 } }
      }
    ])
  }
  const originalFetch = globalThis.fetch
  globalThis.fetch = fetchMock
  try {
    const responsesProfile = normalizeProfile({ ...profile, protocol: 'openai-responses' })
    const provider = createProvider(responsesProfile)
    const result = await provider({
      system: 'sys',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'q' }] },
        {
          role: 'assistant',
          content: [],
          toolCalls: [{ id: 'old', name: 't', arguments: '{}' }]
        },
        { role: 'tool', toolCallId: 'old', content: [{ type: 'text', text: 'ok' }] }
      ],
      tools: [{ name: 'play', description: 'd', parameters: { type: 'object' } }]
    })
    assert.equal(captured.url, 'https://api.example.com/v1/responses')
    assert.ok(captured.body.input.some((item) => item.type === 'function_call_output'))
    assert.ok(captured.body.input.some((item) => item.type === 'function_call'))
    assert.equal(result.text, '答案')
    assert.equal(result.toolCalls[0].id, 'call_9')
    assert.deepEqual(result.usage, { inputTokens: 5, outputTokens: 6 })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('anthropic 携带协议头并解析 tool_use 流', async () => {
  let captured
  const fetchMock = async (url, init) => {
    captured = { url, headers: init.headers, body: JSON.parse(init.body) }
    return sseResponse([
      { type: 'message_start', message: { usage: { input_tokens: 20 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_1', name: 'get_cover' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"trackId":"' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: 't1"}' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '看封面' } },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 9 } }
    ])
  }
  const originalFetch = globalThis.fetch
  globalThis.fetch = fetchMock
  try {
    const claudeProfile = normalizeProfile({
      protocol: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'sk-ant-test',
      model: 'claude-test'
    })
    const provider = createProvider(claudeProfile)
    const result = await provider({
      system: 'sys',
      messages: [
        { role: 'user', content: [{ type: 'image', dataUrl: 'data:image/jpeg;base64,QQQ' }] }
      ],
      tools: [{ name: 'get_cover', description: 'd', parameters: { type: 'object' } }]
    })
    assert.equal(captured.url, 'https://api.anthropic.com/v1/messages')
    assert.equal(captured.headers['anthropic-version'], '2023-06-01')
    assert.equal(captured.body.system, 'sys')
    const wireImage = captured.body.messages[0].content.find((block) => block.type === 'image')
    assert.equal(wireImage.source.media_type, 'image/jpeg')
    assert.equal(wireImage.source.data, 'QQQ')
    assert.equal(result.text, '看封面')
    assert.deepEqual(result.toolCalls, [
      { id: 'tu_1', name: 'get_cover', arguments: '{"trackId":"t1"}' }
    ])
    assert.deepEqual(result.usage, { inputTokens: 20, outputTokens: 9 })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('SSE 解析器处理多行 data 与 DONE', () => {
  const parser = createSseParser()
  const events = parser.feed('data: {"a":1}\n\ndata: [DONE]\n\n')
  assert.equal(events.length, 2)
  assert.deepEqual(events[0].json, { a: 1 })
  assert.equal(events[1].done, true)
})

test('HTTP 错误转换为可读消息', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: false,
    status: 401,
    text: async () => JSON.stringify({ error: { message: 'invalid api key' } })
  })
  try {
    const provider = createProvider(profile)
    await assert.rejects(
      () => provider({ system: 's', messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] }),
      /401.*invalid api key/
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('safeParseArguments 容忍非法 JSON', () => {
  assert.deepEqual(safeParseArguments('{"a":1}'), { a: 1 })
  assert.deepEqual(safeParseArguments('not json'), {})
  assert.deepEqual(safeParseArguments({ b: 2 }), { b: 2 })
})

test('listModels 按 OpenAI 兼容路径拉取并排序', async () => {
  const originalFetch = globalThis.fetch
  let called
  globalThis.fetch = async (url, init) => {
    called = { url, headers: init.headers }
    return {
      ok: true,
      json: async () => ({ data: [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }, { id: 'gpt-4o' }] })
    }
  }
  try {
    const result = await listModels({
      protocol: 'openai-chat',
      baseUrl: 'https://api.example.com/v1/',
      apiKey: 'sk-x'
    })
    assert.equal(called.url, 'https://api.example.com/v1/models')
    assert.equal(called.headers.authorization, 'Bearer sk-x')
    assert.deepEqual(result.models, ['gpt-4o', 'gpt-4o-mini'])
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('listModels 走 Anthropic 端点与请求头', async () => {
  const originalFetch = globalThis.fetch
  let called
  globalThis.fetch = async (url, init) => {
    called = { url, headers: init.headers }
    return { ok: true, json: async () => ({ data: [{ id: 'claude-sonnet-4' }] }) }
  }
  try {
    const result = await listModels({
      protocol: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'sk-ant'
    })
    assert.ok(called.url.startsWith('https://api.anthropic.com/v1/models'))
    assert.equal(called.headers['anthropic-version'], '2023-06-01')
    assert.deepEqual(result.models, ['claude-sonnet-4'])
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('listModels 把 HTTP/网络错误转换为可读消息', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: false, status: 401, text: async () => 'unauthorized' })
  try {
    await assert.rejects(
      () => listModels({ protocol: 'openai-chat', baseUrl: 'https://x.example/v1', apiKey: 'k' }),
      /401/
    )
  } finally {
    globalThis.fetch = originalFetch
  }
  globalThis.fetch = async () => Promise.reject(new Error('boom'))
  try {
    await assert.rejects(
      () => listModels({ protocol: 'openai-chat', baseUrl: 'https://x.example/v1', apiKey: 'k' }),
      /无法连接/
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})
