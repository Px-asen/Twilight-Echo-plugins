import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAgent, buildModelView } from './agent.mjs'
import { createHistory } from './history.mjs'
import { createUsageTracker } from './usage.mjs'
import { createTools } from './tools.mjs'

function fakeContext({ library = {}, appSettings = {}, player = {} } = {}) {
  return {
    twilight: {
      library: {
        queryTracks: library.queryTracks ?? (async () => ({ tracks: [], total: 0 })),
        getTracksByIds: library.getTracksByIds ?? (async () => ({ tracks: [], total: 0 })),
        patchTracks: library.patchTracks ?? (async (patches) => ({ tracks: [], total: 0, applied: patches })),
        getCover: library.getCover ?? (async () => null),
        listPlaylists: library.listPlaylists ?? (async () => ({ items: [] })),
        createPlaylist: library.createPlaylist ?? (async () => ({ id: 'pl_1' })),
        addTracksToPlaylist: library.addTracksToPlaylist ?? (async () => ({})),
        removeTracksFromPlaylist: library.removeTracksFromPlaylist ?? (async () => ({}))
      },
      appSettings: {
        get: appSettings.get ?? (async () => ({ theme: 'dark' })),
        update: appSettings.update ?? (async (patch) => ({ theme: 'dark', ...patch }))
      },
      host: { captureScreenshot: async () => 'data:image/jpeg;base64,ZmFrZQ==' },
      player: {
        getPlaybackInfo: player.getPlaybackInfo ?? (async () => ({ state: 'paused' })),
        play: async () => {},
        pause: async () => {},
        togglePause: async () => {},
        stop: async () => {},
        next: async () => {},
        previous: async () => {},
        playTracks: player.playTracks ?? (async () => {}),
        setVolume: async () => {},
        seek: async () => {},
        setPlayMode: async () => {}
      }
    }
  }
}

function sequenceProvider(responses) {
  const calls = []
  const provider = async ({ system, messages, tools, onDelta }) => {
    calls.push({ system, messages, tools })
    const response = responses[Math.min(calls.length - 1, responses.length - 1)]
    for (const piece of response.text?.match(/.{1,3}/gu) ?? []) onDelta?.(piece)
    return response
  }
  return { provider, calls }
}

function buildHarness({ responses, context, approve = true } = {}) {
  const events = []
  const emit = (sessionId, payload) => events.push({ sessionId, ...payload })
  const confirmCard = async (sessionId, card) => {
    events.push({ sessionId, type: 'card-offer', card })
    return approve
  }
  const usage = { record: async ({ usage }) => usage ?? { inputTokens: 1, outputTokens: 1 } }
  const tools = createTools({ context: context ?? fakeContext() })
  const { provider, calls } = sequenceProvider(responses)
  const agent = createAgent({
    tools,
    emit,
    usage,
    getActiveProfile: () => ({ id: 'p1', model: 'test-model', protocol: 'openai-chat' }),
    createProviderCall: () => provider,
    confirmCard
  })
  return { agent, events, calls }
}

test('纯文本回复：流式 delta 与最终消息', async () => {
  const { agent, events, calls } = await buildHarness({
    responses: [{ text: '这是答案', toolCalls: [] }]
  })
  const session = { id: 's1', messages: [{ role: 'user', content: [{ type: 'text', text: '你好' }] }] }
  const result = await agent.run({ session, signal: new AbortController().signal })
  assert.equal(result.reply, '这是答案')
  assert.ok(events.some((event) => event.type === 'delta'))
  assert.equal(session.messages.at(-1).role, 'assistant')
  assert.equal(calls.length, 1)
  assert.ok(calls[0].system.includes('回声助手'))
  assert.ok(Array.isArray(calls[0].tools) && calls[0].tools.length > 0)
})

test('工具调用循环：执行工具并把结果回传模型', async () => {
  const context = fakeContext({
    library: {
      queryTracks: async () => ({
        total: 1,
        offset: 0,
        revision: 1,
        tracks: [
          { id: 't1', title: 'Blue in Green', artist: 'Miles Davis', album: 'Kind of Blue', genre: 'Jazz', duration: 337, format: 'FLAC', sampleRate: 44100, version: 7 }
        ]
      })
    }
  })
  const { agent, events, calls } = await buildHarness({
    context,
    responses: [
      { text: '我查一下', toolCalls: [{ id: 'c1', name: 'query_library', arguments: '{"search":"blue"}' }] },
      { text: '找到了一首爵士', toolCalls: [] }
    ]
  })
  const session = { id: 's2', messages: [{ role: 'user', content: [{ type: 'text', text: '找 blue' }] }] }
  const result = await agent.run({ session, signal: new AbortController().signal })
  assert.equal(result.reply, '找到了一首爵士')
  const toolMessages = session.messages.filter((message) => message.role === 'tool')
  assert.equal(toolMessages.length, 1)
  assert.match(toolMessages[0].content[0].text, /Blue in Green/)
  assert.equal(calls.length, 2)
  assert.ok(calls[1].messages.some((message) => message.role === 'tool'))
  assert.ok(events.some((event) => event.type === 'tool' && event.status === 'done'))
})

test('写操作先出确认卡：拒绝后不落盘', async () => {
  const updated = []
  const context = fakeContext({
    appSettings: { update: async (patch) => (updated.push(patch), { ...patch }) }
  })
  const { agent, events } = await buildHarness({
    context,
    approve: false,
    responses: [
      { text: '调暗一点', toolCalls: [{ id: 'c1', name: 'update_app_settings', arguments: JSON.stringify({ patch: { uiDensity: 'compact' }, reason: '更紧凑' }) }] },
      { text: '好的，未修改', toolCalls: [] }
    ]
  })
  const session = { id: 's3', messages: [] }
  await agent.run({ session, signal: new AbortController().signal })
  assert.equal(updated.length, 0)
  const card = events.find((event) => event.type === 'card-offer')
  assert.equal(card.card.kind, 'settings')
  assert.equal(card.card.preview.patch.uiDensity, 'compact')
})

test('写操作确认后执行', async () => {
  const patched = []
  const context = fakeContext({
    library: {
      getTracksByIds: async (ids) => ({
        tracks: ids.map((id) => ({ id, title: `T${id}`, version: 3 }))
      }),
      patchTracks: async (patches) => (patched.push(patches), { tracks: [], total: 0 })
    }
  })
  const { agent } = await buildHarness({
    context,
    approve: true,
    responses: [
      { text: '', toolCalls: [{ id: 'c1', name: 'patch_track_metadata', arguments: JSON.stringify({ patches: [{ id: 't9', patch: { genre: 'Jazz' } }], reason: '归一化流派' }) }] },
      { text: '已修正', toolCalls: [] }
    ]
  })
  const session = { id: 's4', messages: [] }
  await agent.run({ session, signal: new AbortController().signal })
  assert.equal(patched.length, 1)
  assert.deepEqual(patched[0], [{ id: 't9', expectedVersion: 3, patch: { genre: 'Jazz' } }])
})

test('截图工具结果附带图片消息', async () => {
  const { agent } = await buildHarness({
    responses: [
      { text: '', toolCalls: [{ id: 'c1', name: 'capture_screenshot', arguments: '{}' }] },
      { text: '界面是深色的', toolCalls: [] }
    ]
  })
  const session = { id: 's5', messages: [] }
  await agent.run({ session, signal: new AbortController().signal })
  const imageMessage = session.messages.find((message) =>
    message.content?.some((block) => block.type === 'image')
  )
  assert.ok(imageMessage, '应把截图作为图片消息加入上下文')
})

test('取消：中止循环并抛出 AbortError', async () => {
  const controller = new AbortController()
  const { agent } = await buildHarness({
    responses: [{ text: 'never', toolCalls: [] }]
  })
  const session = { id: 's6', messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] }
  controller.abort(new Error('停止'))
  await assert.rejects(() => agent.run({ session, signal: controller.signal }))
})

test('buildModelView 裁剪旧图片和陈旧工具结果', () => {
  const messages = []
  for (let i = 0; i < 12; i += 1) {
    messages.push({ role: 'user', content: [{ type: 'text', text: `m${i}` }, { type: 'image', dataUrl: 'data:image/png;base64,X' }] })
    messages.push({ role: 'tool', toolCallId: `c${i}`, content: [{ type: 'text', text: 'result'.repeat(100) }] })
  }
  const view = buildModelView(messages)
  assert.equal(view[0].content[0].text, 'm0')
  assert.equal(view[0].content[1].text, '[更早的图片已省略]')
  assert.equal(view[1].content[0].text, '[较早的工具结果已省略]')
  const lastUser = view.filter((message) => message.role === 'user').at(-1)
  assert.ok(lastUser.content.some((block) => block.type === 'image'))
})

test('history 会话持久化并裁剪图片', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'echo-history-'))
  try {
    const history = createHistory({ storagePath: dir })
    const session = await history.createSession()
    session.messages.push({
      role: 'user',
      content: [
        { type: 'text', text: '看看界面' },
        { type: 'image', dataUrl: 'data:image/png;base64,VERYLONG' }
      ]
    })
    session.messages.push({ role: 'assistant', content: [{ type: 'text', text: '收到' }] })
    await history.saveSession(session)
    const loaded = await history.loadSession(session.id)
    assert.equal(loaded.messages[0].content[1].type, 'text')
    assert.ok(loaded.messages[0].hadImage)
    const listed = await history.listSessions()
    assert.equal(listed.length, 1)
    assert.ok(listed[0].messageCount >= 2)
    await history.deleteSession(session.id)
    assert.equal((await history.listSessions()).length, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('usage 按月与配置聚合成本', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'echo-usage-'))
  try {
    const usage = createUsageTracker({ storagePath: dir })
    const first = await usage.record({
      profileId: 'p1',
      model: 'm1',
      usage: { inputTokens: 1_000_000, outputTokens: 500_000 },
      pricing: { inputPerMillion: 1, outputPerMillion: 2 }
    })
    assert.equal(first.cost, 2)
    await usage.record({
      profileId: 'p1',
      model: 'm1',
      usage: { inputTokens: 0, outputTokens: 0 },
      pricing: { inputPerMillion: 1, outputPerMillion: 2 }
    })
    const summary = await usage.summary()
    assert.equal(summary.calls, 2)
    assert.equal(summary.cost, 2)
    assert.equal(summary.byProfile.p1.models.m1.calls, 2)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
