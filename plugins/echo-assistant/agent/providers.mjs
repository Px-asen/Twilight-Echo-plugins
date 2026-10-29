/**
 * LLM protocol adapters. All adapters share one normalized surface:
 *
 *   chat({ profile, system, messages, tools, signal, onDelta })
 *     -> { text, toolCalls: [{ id, name, arguments }], usage: { inputTokens, outputTokens } }
 *
 * `messages` use the internal format:
 *   { role: 'user' | 'assistant' | 'tool',
 *     content: [{ type: 'text', text } | { type: 'image', dataUrl }],
 *     toolCalls?: [{ id, name, arguments }],
 *     toolCallId?, name? }
 *
 * Images are passed as data URLs; each adapter converts to its wire format.
 * Streaming uses SSE; text deltas are forwarded through onDelta as they
 * arrive so the chat panel can render progressively.
 */

import { abortable, throwIfAborted } from './runtime.mjs'

export const PROTOCOLS = ['openai-chat', 'openai-responses', 'anthropic']

const DEFAULT_BASE_URLS = {
  'openai-chat': 'https://api.openai.com/v1',
  'openai-responses': 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com'
}

export function normalizeProfile(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('无效的 API 配置')
  const protocol = PROTOCOLS.includes(raw.protocol) ? raw.protocol : 'openai-chat'
  const baseUrl = trimUrl(raw.baseUrl || DEFAULT_BASE_URLS[protocol])
  const apiKey = typeof raw.apiKey === 'string' ? raw.apiKey.trim() : ''
  const model = typeof raw.model === 'string' ? raw.model.trim() : ''
  if (!/^https?:\/\//i.test(baseUrl)) throw new Error('API 地址必须以 http(s):// 开头')
  if (!apiKey && !isLoopback(baseUrl)) throw new Error('缺少 API Key（本地服务可留空）')
  if (!model) throw new Error('缺少模型名称')
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : createId(),
    label: boundedString(raw.label, 60) || model,
    protocol,
    baseUrl,
    apiKey,
    model,
    vision: raw.vision !== false,
    temperature: clampNumber(raw.temperature, 0, 2, 0.6),
    pricing: {
      inputPerMillion: clampNumber(raw.pricing?.inputPerMillion, 0, 10000, 0),
      outputPerMillion: clampNumber(raw.pricing?.outputPerMillion, 0, 10000, 0)
    }
  }
}

export function maskedProfile(profile) {
  return { ...profile, apiKey: profile.apiKey ? maskKey(profile.apiKey) : '' }
}

function isLoopback(url) {
  try {
    const host = new URL(url).hostname
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]'
  } catch {
    return false
  }
}

function maskKey(key) {
  if (key.length <= 8) return '****'
  return `${key.slice(0, 4)}****${key.slice(-4)}`
}

function trimUrl(url) {
  return String(url || '').trim().replace(/\/+$/, '')
}

function boundedString(value, max) {
  if (typeof value !== 'string') return ''
  return value.trim().slice(0, max)
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, number))
}

export function createId() {
  return `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

/** Incremental SSE reader: feed() accepts body chunks and yields parsed events. */
export function createSseParser() {
  let buffer = ''
  const take = (flush = false) => {
    const events = []
    let match
    while ((match = /\r?\n\r?\n/.exec(buffer))) {
      const block = buffer.slice(0, match.index)
      buffer = buffer.slice(match.index + match[0].length)
      const event = parseSseBlock(block)
      if (event) events.push(event)
    }
    if (flush && buffer.trim()) {
      const event = parseSseBlock(buffer)
      if (event) events.push(event)
      buffer = ''
    }
    return events
  }
  return { feed(chunk) { buffer += chunk; return take() }, finish() { return take(true) } }
}

function parseSseBlock(block) {
  const data = block.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart())
  if (!data.length) return null
  const payload = data.join('\n')
  if (payload === '[DONE]') return { done: true }
  try { return { json: JSON.parse(payload) } } catch { return { text: payload } }
}

export async function* iterateBody(body, signal) {
  if (!body) throw new Error('服务没有返回响应内容')
  const reader = body.getReader()
  const decoder = new TextDecoder()
  try {
    for (;;) {
      throwIfAborted(signal)
      const { done, value } = await abortable(reader.read(), signal)
      if (done) { const tail = decoder.decode(); if (tail) yield tail; return }
      if (value) yield decoder.decode(value, { stream: true })
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

async function* iterateEvents(body, signal, onActivity) {
  const parser = createSseParser()
  const process = event => {
    if (event.json?.error) throw new Error(event.json.error.message || String(event.json.error))
    const payload = event.json
    const modelActivity = payload && (payload.choices?.length || payload.usage || payload.type?.startsWith('response.') ||
      ['message_start', 'message_delta', 'message_stop', 'content_block_start', 'content_block_delta', 'content_block_stop'].includes(payload.type))
    if (modelActivity || event.done) onActivity?.()
    return event
  }
  for await (const chunk of iterateBody(body, signal)) {
    for (const event of parser.feed(chunk)) yield process(event)
  }
  for (const event of parser.finish()) yield process(event)
}

async function readError(response) {
  let detail = ''
  try {
    const text = await response.text()
    try {
      const json = JSON.parse(text)
      detail = json?.error?.message || json?.message || text
    } catch {
      detail = text
    }
  } catch {
    /* ignore */
  }
  detail = String(detail).slice(0, 500)
  return `HTTP ${response.status}${detail ? `：${detail}` : ''}`
}

function splitDataUrl(dataUrl) {
  const match = /^data:(image\/(?:png|jpe?g|webp|gif));base64,(.+)$/i.exec(dataUrl || '')
  if (!match) return null
  return { mediaType: match[1].toLowerCase(), data: match[2] }
}

async function postJson(url, headers, body, signal) {
  const response = await abortable(fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal
  }), signal)
  if (!response.ok) throw new Error(await readError(response))
  return response
}

/* ---------------------------------------------------------------------------
 * OpenAI Chat Completions
 * ------------------------------------------------------------------------- */

async function openaiChat({ profile, system, messages, tools, signal, onDelta, onActivity }) {
  const url = `${profile.baseUrl}/chat/completions`
  const body = {
    model: profile.model,
    messages: [
      { role: 'system', content: system },
      ...messages.map(toOpenAiChatMessage).filter(Boolean)
    ],
    stream: true,
    stream_options: { include_usage: true },
    temperature: profile.temperature
  }
  if (tools?.length) body.tools = tools.map(toOpenAiTool)

  const response = await postJson(
    url,
    { authorization: profile.apiKey ? `Bearer ${profile.apiKey}` : '' },
    body,
    signal
  )
  let text = ''
  const toolCalls = []
  let usage = null
  for await (const event of iterateEvents(response.body, signal, onActivity)) {
      if (event.done) break
      if (!event.json) continue
      const delta = event.json.choices?.[0]?.delta
      if (typeof delta?.content === 'string' && delta.content) {
        text += delta.content
        onDelta?.(delta.content)
      }
      for (const call of delta?.tool_calls ?? []) {
        const index = call.index ?? 0
        toolCalls[index] ??= { id: '', name: '', arguments: '' }
        if (call.id) toolCalls[index].id = call.id
        if (call.function?.name) toolCalls[index].name += call.function.name
        if (call.function?.arguments) toolCalls[index].arguments += call.function.arguments
      }
      if (event.json.usage) {
        usage = {
          inputTokens: event.json.usage.prompt_tokens ?? 0,
          outputTokens: event.json.usage.completion_tokens ?? 0
        }
      }
  }
  return {
    text,
    toolCalls: toolCalls.filter((call) => call.name),
    usage: usage ?? estimateUsage(system, messages, text)
  }
}

function toOpenAiChatMessage(message) {
  if (message.role === 'tool') {
    return {
      role: 'tool',
      tool_call_id: message.toolCallId,
      content: stringifyContent(message.content)
    }
  }
  if (message.role === 'assistant') {
    const entry = { role: 'assistant', content: message.content?.length ? stringifyContent(message.content) : null }
    if (message.toolCalls?.length) {
      entry.tool_calls = message.toolCalls.map((call) => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: call.arguments }
      }))
    }
    return entry
  }
  const images = message.content.filter((block) => block.type === 'image')
  const texts = message.content.filter((block) => block.type === 'text')
  if (!images.length) {
    return { role: 'user', content: stringifyContent(texts) || ' ' }
  }
  return {
    role: 'user',
    content: [
      ...texts.map((block) => ({ type: 'text', text: block.text })),
      ...images.map((block) => ({ type: 'image_url', image_url: { url: block.dataUrl } }))
    ]
  }
}

function toOpenAiTool(tool) {
  return { type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } }
}

/* ---------------------------------------------------------------------------
 * OpenAI Responses
 * ------------------------------------------------------------------------- */

async function openaiResponses({ profile, system, messages, tools, signal, onDelta, onActivity }) {
  const url = `${profile.baseUrl}/responses`
  const body = {
    model: profile.model,
    instructions: system,
    input: messages.flatMap(toResponsesItem).filter(Boolean),
    stream: true,
    temperature: profile.temperature
  }
  if (tools?.length) body.tools = tools.map((tool) => ({ type: 'function', name: tool.name, description: tool.description, parameters: tool.parameters }))

  const response = await postJson(
    url,
    { authorization: profile.apiKey ? `Bearer ${profile.apiKey}` : '' },
    body,
    signal
  )
  let text = ''
  const toolCalls = []
  let usage = null
  const partial = new Map()
  for await (const event of iterateEvents(response.body, signal, onActivity)) {
      if (event.done) break
      if (!event.json) continue
      const payload = event.json
      if (payload.type === 'response.output_text.delta' && payload.delta) {
        text += payload.delta
        onDelta?.(payload.delta)
      } else if (payload.type === 'response.output_item.added' && payload.item?.type === 'function_call') {
        partial.set(payload.item.id ?? String(toolCalls.length), {
          id: payload.item.call_id ?? payload.item.id ?? '',
          name: payload.item.name ?? '',
          arguments: ''
        })
      } else if (payload.type === 'response.function_call_arguments.delta') {
        const key = payload.item_id ?? payload.item?.id
        const entry = partial.get(key)
        if (entry && payload.delta) entry.arguments += payload.delta
      } else if (payload.type === 'response.output_item.done' && payload.item?.type === 'function_call') {
        const call = partial.get(payload.item.id ?? '')
        const final = {
          id: payload.item.call_id ?? payload.item.id,
          name: payload.item.name,
          arguments: payload.item.arguments ?? call?.arguments ?? '{}'
        }
        if (final.name) toolCalls.push(final)
      } else if (payload.type === 'response.completed') {
        if (payload.response?.usage) usage = { inputTokens: payload.response.usage.input_tokens ?? 0, outputTokens: payload.response.usage.output_tokens ?? 0 }
        break
      } else if (payload.type === 'response.failed' || payload.type === 'response.incomplete') {
        throw new Error(payload.response?.error?.message || payload.response?.incomplete_details?.reason || '模型响应未完成，请重试')
      }
  }
  for (const entry of partial.values()) {
    if (entry.name && !toolCalls.some((call) => call.id === entry.id)) toolCalls.push(entry)
  }
  return {
    text,
    toolCalls,
    usage: usage ?? estimateUsage(system, messages, text)
  }
}

function toResponsesItem(message) {
  if (message.role === 'tool') {
    return {
      type: 'function_call_output',
      call_id: message.toolCallId,
      output: stringifyContent(message.content)
    }
  }
  if (message.role === 'assistant') {
    const items = []
    if (message.content?.length) {
      items.push({ role: 'assistant', content: stringifyContent(message.content) })
    }
    for (const call of message.toolCalls ?? []) {
      items.push({ type: 'function_call', call_id: call.id, name: call.name, arguments: call.arguments })
    }
    return items.length === 1 ? items[0] : items
  }
  const images = message.content.filter((block) => block.type === 'image')
  const texts = message.content.filter((block) => block.type === 'text')
  if (!images.length) {
    return { role: 'user', content: stringifyContent(texts) || ' ' }
  }
  return {
    role: 'user',
    content: [
      ...texts.map((block) => ({ type: 'input_text', text: block.text })),
      ...images.map((block) => ({ type: 'input_image', image_url: block.dataUrl }))
    ]
  }
}

/* ---------------------------------------------------------------------------
 * Anthropic Messages
 * ------------------------------------------------------------------------- */

async function anthropic({ profile, system, messages, tools, signal, onDelta, onActivity }) {
  const url = `${profile.baseUrl}/v1/messages`
  const body = {
    model: profile.model,
    system,
    max_tokens: 8192,
    stream: true,
    temperature: profile.temperature,
    messages: messages.map(toAnthropicMessage).filter(Boolean)
  }
  if (tools?.length) {
    body.tools = tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.parameters }))
  }

  const response = await postJson(
    url,
    {
      'x-api-key': profile.apiKey,
      'anthropic-version': '2023-06-01'
    },
    body,
    signal
  )
  let text = ''
  const toolCalls = []
  let usage = null
  const activeTool = new Map()
  let currentToolId = null
  let currentToolName = null
  let currentToolArgs = ''
  for await (const event of iterateEvents(response.body, signal, onActivity)) {
      if (event.done) break
      if (!event.json) continue
      const payload = event.json
      if (payload.type === 'message_stop') break
      if (payload.type === 'content_block_start' && payload.content_block?.type === 'tool_use') {
        currentToolId = payload.content_block.id
        currentToolName = payload.content_block.name
        currentToolArgs = ''
      } else if (payload.type === 'content_block_delta') {
        const delta = payload.delta
        if (delta?.type === 'text_delta' && delta.text) {
          text += delta.text
          onDelta?.(delta.text)
        } else if (delta?.type === 'input_json_delta' && delta.partial_json) {
          currentToolArgs += delta.partial_json
        }
      } else if (payload.type === 'content_block_stop' && currentToolId) {
        activeTool.set(currentToolId, {
          id: currentToolId,
          name: currentToolName,
          arguments: currentToolArgs || '{}'
        })
        currentToolId = null
        currentToolName = null
        currentToolArgs = ''
      } else if (payload.type === 'message_delta' && payload.usage) {
        usage = {
          inputTokens: usage?.inputTokens ?? payload.usage.input_tokens ?? 0,
          outputTokens: payload.usage.output_tokens ?? usage?.outputTokens ?? 0
        }
      } else if (payload.type === 'message_start' && payload.message?.usage) {
        usage = {
          inputTokens: payload.message.usage.input_tokens ?? 0,
          outputTokens: payload.message.usage.output_tokens ?? 0
        }
      }
  }
  for (const call of activeTool.values()) {
    if (call.name) toolCalls.push(call)
  }
  return {
    text,
    toolCalls,
    usage: usage ?? estimateUsage(system, messages, text)
  }
}

function toAnthropicMessage(message) {
  if (message.role === 'tool') {
    return {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: message.toolCallId,
          content: stringifyContent(message.content)
        }
      ]
    }
  }
  if (message.role === 'assistant') {
    const content = []
    for (const block of message.content ?? []) {
      if (block.type === 'text' && block.text) content.push({ type: 'text', text: block.text })
    }
    for (const call of message.toolCalls ?? []) {
      content.push({ type: 'tool_use', id: call.id, name: call.name, input: safeParseArguments(call.arguments) })
    }
    if (!content.length) content.push({ type: 'text', text: ' ' })
    return { role: 'assistant', content }
  }
  const content = []
  for (const block of message.content) {
    if (block.type === 'text' && block.text) content.push({ type: 'text', text: block.text })
    if (block.type === 'image') {
      const image = splitDataUrl(block.dataUrl)
      if (image) {
        content.push({ type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.data } })
      }
    }
  }
  if (!content.length) content.push({ type: 'text', text: ' ' })
  return { role: 'user', content }
}

/* --------------------------------------------------------------------------- */

export function createProvider(profile, { idleTimeoutMs = 120000 } = {}) {
  const adapter = profile.protocol === 'anthropic' ? anthropic : profile.protocol === 'openai-responses' ? openaiResponses : openaiChat
  return async options => {
    const controller = new AbortController()
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal
    let timer
    const touch = () => {
      clearTimeout(timer)
      timer = setTimeout(() => controller.abort(new Error('服务响应超时：连续 120 秒没有有效响应，请重试或检查网络与模型服务')), idleTimeoutMs)
      timer.unref?.()
    }
    touch()
    try {
      return await abortable(adapter({ ...options, profile, signal, onActivity: touch }), signal)
    } finally { clearTimeout(timer) }
  }
}

/**
 * Lists model ids from the service so the chat panel can offer a picker
 * instead of asking the user to type model names. Runs in the plugin process
 * (proxy-aware fetch); the iframe cannot reach the network itself.
 */
export async function listModels({ protocol, baseUrl, apiKey }) {
  const normalizedBase = trimUrl(baseUrl || DEFAULT_BASE_URLS[protocol] || DEFAULT_BASE_URLS['openai-chat'])
  if (!/^https?:\/\//i.test(normalizedBase)) throw new Error('API 地址必须以 http(s):// 开头')
  const url =
    protocol === 'anthropic'
      ? `${normalizedBase}/v1/models?limit=200`
      : `${normalizedBase}/models`
  const headers =
    protocol === 'anthropic'
      ? { 'x-api-key': apiKey ?? '', 'anthropic-version': '2023-06-01' }
      : { authorization: apiKey ? `Bearer ${apiKey}` : '' }
  let response
  try {
    response = await fetch(url, { headers, signal: AbortSignal.timeout(20000) })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/abort|timeout/i.test(message)) {
      throw new Error('连接超时（20 秒）：检查 API 地址是否正确、服务是否在线，以及应用的网络代理设置')
    }
    throw new Error(`无法连接 API 地址：${message}`)
  }
  if (!response.ok) throw new Error(await readError(response))
  const json = await response.json().catch(() => null)
  const data = Array.isArray(json?.data) ? json.data : []
  const models = [...new Set(
    data
      .map((item) => (typeof item?.id === 'string' ? item.id.trim() : ''))
      .filter(Boolean)
  )]
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
    .slice(0, 300)
  if (!models.length) throw new Error('服务没有返回任何模型')
  return { models }
}

function stringifyContent(content) {
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => (block.type === 'text' ? block.text : '[图片]'))
    .join('\n')
    .slice(0, 40000)
}

export function safeParseArguments(raw) {
  if (raw && typeof raw === 'object') return raw
  try {
    const parsed = JSON.parse(String(raw || '{}'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/** Fallback usage estimate when a provider omits token counts. */
export function estimateUsage(system, messages, output) {
  const input = `${system}\n${JSON.stringify(messages ?? [])}`
  return {
    inputTokens: Math.ceil(input.length / 3),
    outputTokens: Math.ceil(String(output ?? '').length / 3),
    estimated: true
  }
}
