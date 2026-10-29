import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createGateway } from './gateway.mjs'

function fakeContext(root) {
  const store = new Map()
  const events = []
  const commands = new Map()
  const contributions = []
  return {
    events,
    context: {
      storagePath: root,
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      settings: {
        get: async (key) => store.get(key),
        set: async (key, value) => {
          store.set(key, value)
        },
        delete: async (key) => store.delete(key)
      },
      twilight: {
        experience: {
          onRequest() {},
          emit: (event, value) => events.push({ event, value })
        },
        ui: {
          register: async (contribution) => contributions.push(contribution),
          onCommand: (command, handler) => {
            commands.set(command, handler)
            return () => commands.delete(command)
          },
          notify: async () => {}
        },
        library: {
          queryTracks: async () => ({ tracks: [], total: 0 }),
          getTracksByIds: async () => ({ tracks: [], total: 0 }),
          patchTracks: async () => ({ tracks: [], total: 0 }),
          getCover: async () => null,
          listPlaylists: async () => ({ items: [] }),
          createPlaylist: async () => ({ id: 'pl_1' }),
          addTracksToPlaylist: async () => ({}),
          removeTracksFromPlaylist: async () => ({})
        },
        appSettings: { get: async () => ({}), update: async () => ({}) },
        host: { captureScreenshot: async () => null },
        player: {
          getPlaybackInfo: async () => null,
          play: async () => {}, pause: async () => {}, togglePause: async () => {},
          stop: async () => {}, next: async () => {}, previous: async () => {},
          playTracks: async () => {}, setVolume: async () => {}, seek: async () => {},
          setPlayMode: async () => {}
        }
      }
    },
    store,
    commands,
    contributions
  }
}

async function withGateway(run) {
  const root = await mkdtemp(join(tmpdir(), 'echo-gateway-'))
  const fake = fakeContext(root)
  const gateway = createGateway(fake.context)
  await gateway.initialize()
  try {
    await run(gateway, fake)
  } finally {
    await gateway.dispose()
    await rm(root, { recursive: true, force: true })
  }
}

const PROFILE = {
  label: '测试配置',
  protocol: 'openai-chat',
  baseUrl: 'https://api.example.com/v1',
  apiKey: 'sk-key-123456',
  model: 'gpt-test'
}

test('profile 保存/掩码/激活', async () => {
  await withGateway(async (gateway) => {
    const saved = await gateway.handleRequest({ type: 'profile.save', profile: PROFILE })
    assert.equal(saved.profiles.length, 1)
    assert.ok(saved.profiles[0].apiKey.includes('****'))
    assert.ok(!saved.profiles[0].apiKey.includes('123456'))
    assert.equal(saved.activeProfileId, saved.profiles[0].id)

    const state = await gateway.handleRequest({ type: 'state' })
    assert.equal(state.profiles.length, 1)
    assert.equal(state.ready, true)
  })
})

test('profile.save 保留旧 key：编辑时传空 key 不清空', async () => {
  await withGateway(async (gateway) => {
    const first = await gateway.handleRequest({ type: 'profile.save', profile: PROFILE })
    const id = first.profiles[0].id
    const second = await gateway.handleRequest({
      type: 'profile.save',
      profile: { ...PROFILE, id, apiKey: '', label: '改名' }
    })
    assert.equal(second.profiles[0].label, '改名')
    const state = await gateway.handleRequest({ type: 'state' })
    assert.ok(!state.profiles[0].apiKey.includes('********'))
    assert.ok(state.profiles[0].apiKey.includes('****'))
  })
})

test('会话创建/加载/删除', async () => {
  await withGateway(async (gateway) => {
    await gateway.handleRequest({ type: 'profile.save', profile: PROFILE })
    const created = await gateway.handleRequest({ type: 'session.new' })
    const sessionId = created.session.id
    assert.equal(created.session.title, '新对话')

    const loaded = await gateway.handleRequest({ type: 'session.load', id: sessionId })
    assert.equal(loaded.session.id, sessionId)

    const listed = await gateway.handleRequest({ type: 'session.list' })
    assert.equal(listed.sessions.length, 1)

    await gateway.handleRequest({ type: 'session.delete', id: sessionId })
    const afterDelete = await gateway.handleRequest({ type: 'session.list' })
    assert.equal(afterDelete.sessions.length, 0)
  })
})

test('chat.send 未配置 API 时报错', async () => {
  await withGateway(async (gateway) => {
    await assert.rejects(
      () => gateway.handleRequest({ type: 'chat.send', text: '你好' }),
      /尚未配置/
    )
  })
})

test('settingsPanel 注册与表单读写', async () => {
  await withGateway(async (gateway, fake) => {
    await gateway.registerSettingsPanel()
    assert.equal(
      fake.contributions.find((entry) => entry.id === 'echo-assistant-titlebar')?.kind,
      'titleBarButton'
    )
    assert.ok(fake.contributions.some((entry) => entry.kind === 'settingsPanel'))
    const form = await fake.commands.get('echo-assistant.settings')()
    assert.equal(form.kind, 'settings-form')
    assert.ok(form.fields.some((field) => field.key === 'model'))

    await fake.commands.get('echo-assistant.settings.save')({
      label: '我的配置',
      protocol: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'sk-ant-1',
      model: 'claude-x',
      vision: 'false',
      temperature: '0.3',
      inputPerMillion: '3',
      outputPerMillion: '15'
    })
    const state = await gateway.handleRequest({ type: 'state' })
    assert.equal(state.profiles.length, 1)
    assert.equal(state.profiles[0].protocol, 'anthropic')
    assert.equal(state.profiles[0].vision, false)
  })
})

test('无效请求被拒绝', async () => {
  await withGateway(async (gateway) => {
    await assert.rejects(() => gateway.handleRequest(null), /无效请求/)
    await assert.rejects(() => gateway.handleRequest({ type: 'nope' }), /未知请求/)
  })
})

test('models.list 拉取模型并可复用已存 key', async () => {
  await withGateway(async (gateway) => {
    const saved = await gateway.handleRequest({ type: 'profile.save', profile: PROFILE })
    const profileId = saved.profiles[0].id

    const originalFetch = globalThis.fetch
    let called
    globalThis.fetch = async (url, init) => {
      called = { url, headers: init.headers }
      return { ok: true, json: async () => ({ data: [{ id: 'gpt-test' }] }) }
    }
    try {
      // 空 apiKey + 已有 profileId → 复用存储的 key
      const result = await gateway.handleRequest({
        type: 'models.list',
        protocol: 'openai-chat',
        baseUrl: 'https://api.example.com/v1',
        apiKey: '',
        profileId
      })
      assert.deepEqual(result.models, ['gpt-test'])
      assert.equal(called.headers.authorization, `Bearer ${PROFILE.apiKey}`)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

test('models.list 走真实本地 HTTP 服务端到端返回', async () => {
  const http = await import('node:http')
  const server = http.createServer((request, response) => {
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ data: [{ id: 'local-model-a' }, { id: 'local-model-b' }] }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  try {
    await withGateway(async (gateway) => {
      const result = await gateway.handleRequest({
        type: 'models.list',
        protocol: 'openai-chat',
        baseUrl: `http://127.0.0.1:${port}/v1`,
        apiKey: ''
      })
      assert.deepEqual(result.models, ['local-model-a', 'local-model-b'])
    })
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('models.list 对不可达地址在有限时间内报错而不是挂起', async () => {
  await withGateway(async (gateway) => {
    await assert.rejects(
      () =>
        gateway.handleRequest({
          type: 'models.list',
          protocol: 'openai-chat',
          baseUrl: 'http://127.0.0.1:9/v1',
          apiKey: ''
        })
    )
  })
})

async function until(predicate) {
  for (let index = 0; index < 200; index++) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('等待测试事件超时')
}
function stream(events, { open = false } = {}) {
  return new Response(new ReadableStream({ start(controller) {
    const encoder = new TextEncoder()
    for (const event of events) controller.enqueue(encoder.encode(`data: ${typeof event === 'string' ? event : JSON.stringify(event)}\r\n\r\n`))
    if (!open) controller.close()
  } }))
}

test('chat 完成包含终态快照；DONE 后连接不关闭也结束，可以立即再次发送', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => stream([{ choices: [{ delta: { content: '你好' } }] }, '[DONE]'], { open: true })
  try {
    await withGateway(async (gateway, fake) => {
      await gateway.handleRequest({ type: 'profile.save', profile: PROFILE })
      const sent = await gateway.handleRequest({ type: 'chat.send', text: 'hello' })
      await until(() => fake.events.some(event => event.value.type === 'done'))
      const done = fake.events.find(event => event.value.type === 'done').value
      assert.equal(done.run.phase, 'done')
      assert.ok(done.revision >= sent.run.revision)
      assert.equal(done.session.messages.at(-1).content[0].text, '你好')
      const next = await gateway.handleRequest({ type: 'chat.send', sessionId: sent.sessionId, text: 'again' })
      await until(() => fake.events.filter(event => event.value.type === 'done').length === 2)
      assert.notEqual(next.run.id, sent.run.id)
      const cancelled = await gateway.handleRequest({ type: 'chat.cancel', sessionId: sent.sessionId })
      assert.equal(cancelled.cancelled, false)
      assert.equal(cancelled.run.phase, 'done')
    })
  } finally { globalThis.fetch = original }
})

test('运行中停止保留部分回答；终态只发一次，旧运行的停止不影响新运行', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => stream([{ choices: [{ delta: { content: '部分回答' } }] }], { open: true })
  try {
    await withGateway(async (gateway, fake) => {
      await gateway.handleRequest({ type: 'profile.save', profile: PROFILE })
      const sent = await gateway.handleRequest({ type: 'chat.send', text: 'hello' })
      await until(() => fake.events.some(event => event.value.type === 'delta'))
      const loaded = await gateway.handleRequest({ type: 'session.load', id: sent.sessionId })
      assert.equal(loaded.run.streaming, '部分回答')
      await gateway.handleRequest({ type: 'chat.cancel', sessionId: sent.sessionId, runId: sent.run.id })
      await gateway.handleRequest({ type: 'chat.cancel', sessionId: sent.sessionId, runId: sent.run.id })
      await until(() => fake.events.some(event => event.value.type === 'done'))
      const done = fake.events.find(event => event.value.type === 'done').value
      assert.equal(done.run.phase, 'cancelled')
      assert.equal(done.session.messages.at(-1).interrupted, true)
      assert.equal(done.session.messages.at(-1).content[0].text, '部分回答')
      assert.equal(fake.events.filter(event => event.value.type === 'done').length, 1)
      const next = await gateway.handleRequest({ type: 'chat.send', sessionId: sent.sessionId, text: '继续' })
      const staleCancel = await gateway.handleRequest({ type: 'chat.cancel', sessionId: sent.sessionId, runId: sent.run.id })
      assert.equal(staleCancel.cancelled, false)
      assert.equal(staleCancel.run.id, next.run.id)
    })
  } finally { globalThis.fetch = original }
})

test('确认等待可停止，未批准的修改不执行，剩余工具调用均补取消结果', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => stream([{ choices: [{ delta: { tool_calls: [
    { index: 0, id: 'write_1', function: { name: 'update_app_settings', arguments: '{"patch":{"theme":"dark"},"reason":"测试"}' } },
    { index: 1, id: 'write_2', function: { name: 'update_app_settings', arguments: '{"patch":{"theme":"light"},"reason":"测试"}' } }
  ] } }] }, '[DONE]'])
  try {
    await withGateway(async (gateway, fake) => {
      let writes = 0
      fake.context.twilight.appSettings.update = async () => { writes++; return {} }
      await gateway.handleRequest({ type: 'profile.save', profile: PROFILE })
      const sent = await gateway.handleRequest({ type: 'chat.send', text: '改设置' })
      await until(() => fake.events.some(event => event.value.type === 'card'))
      const loaded = await gateway.handleRequest({ type: 'session.load', id: sent.sessionId })
      assert.equal(loaded.run.phase, 'confirming')
      assert.equal(loaded.run.cards.length, 1)
      await gateway.handleRequest({ type: 'chat.cancel', sessionId: sent.sessionId })
      await until(() => fake.events.some(event => event.value.type === 'done'))
      const done = fake.events.find(event => event.value.type === 'done').value
      assert.equal(writes, 0)
      assert.equal(done.run.phase, 'cancelled')
      assert.equal(done.run.cards[0].cancelled, true)
      assert.equal(done.run.hadWrites, false)
      assert.deepEqual(done.session.messages.filter(message => message.role === 'tool').map(message => message.toolCallId), ['write_1', 'write_2'])
      assert.equal((await gateway.handleRequest({ type: 'chat.confirm', cardId: loaded.run.cards[0].card.id, approved: true })).resolved, false)
    })
  } finally { globalThis.fetch = original }
})

test('无 API 全库体检、报告保存重载，不触发模型或写入', async () => {
  await withGateway(async (gateway, fake) => {
    let pages = 0
    fake.context.twilight.library.queryTracks = async ({ offset, limit }) => {
      pages++
      return { revision: 1, total: 4101, tracks: Array.from({ length: Math.max(0, Math.min(limit, 4101 - offset)) }, (_, index) => ({ id: `t_${offset + index}`, title: 'Song', format: 'FLAC', sampleRate: 96000, bitDepth: 24 })) }
    }
    const sent = await gateway.handleRequest({ type: 'workflow.start', kind: 'quality' })
    await until(() => fake.events.some(event => event.value.type === 'done'))
    assert.equal(pages, 21)
    const loaded = await gateway.handleRequest({ type: 'session.load', id: sent.sessionId })
    assert.equal(pages, 22) // One lightweight revision query when reopening the saved report.
    assert.equal(loaded.session.messages.at(-1).report.result.scanned, 4101)
    assert.equal(loaded.session.messages.at(-1).report.result.complete, true)
    assert.equal((await gateway.handleRequest({ type: 'usage.summary' })).calls, 0)
    const another = createGateway(fake.context)
    await another.initialize()
    const restored = await another.handleRequest({ type: 'session.load', id: sent.sessionId })
    assert.equal(restored.session.messages.at(-1).report.result.hiRes, 4101)
    await another.dispose()
  })
})

test('曲库后来发生变化时，重载报告标注过期并同步给模型的摘要', async () => {
  await withGateway(async (gateway, fake) => {
    let revision = 1
    fake.context.twilight.library.queryTracks = async () => ({ revision, total: 1, tracks: [{ id: 't1', title: 'Song', format: 'FLAC' }] })
    const sent = await gateway.handleRequest({ type: 'workflow.start', kind: 'quality' })
    await until(() => fake.events.some(event => event.value.type === 'done'))
    revision = 2
    const loaded = await gateway.handleRequest({ type: 'session.load', id: sent.sessionId })
    const report = loaded.session.messages.at(-1)
    assert.equal(report.report.result.libraryRevision, 1)
    assert.equal(report.report.result.stale, true)
    assert.equal(report.report.result.complete, false)
    assert.match(report.content[0].text, /结果已过期/)
  })
})

test('扫描等待数据库时也能停止并保存部分结果', async () => {
  await withGateway(async (gateway, fake) => {
    fake.context.twilight.library.queryTracks = async ({ offset }) => offset === 0
      ? { revision: 1, total: 500, tracks: Array.from({ length: 200 }, (_, i) => ({ id: `t${i}`, title: `Title ${i}` })) }
      : new Promise(() => {})
    const sent = await gateway.handleRequest({ type: 'workflow.start', kind: 'duplicates' })
    await until(() => fake.events.some(event => event.value.type === 'progress'))
    await gateway.handleRequest({ type: 'chat.cancel', sessionId: sent.sessionId })
    await until(() => fake.events.some(event => event.value.type === 'done'))
    const result = (await gateway.handleRequest({ type: 'session.load', id: sent.sessionId })).session.messages.at(-1).report.result
    assert.equal(result.scanned, 200)
    assert.equal(result.cancelled, true)
    assert.equal(result.complete, false)
  })
})

test('角色库独立保存，默认角色与会话快照隔离，旧会话使用通用角色', async () => {
  await withGateway(async (gateway, fake) => {
    const before = await gateway.handleRequest({ type: 'session.new' })
    const state = await gateway.handleRequest({ type: 'state' })
    state.promptLibrary.presets.find(preset => preset.id === 'curator').systemPrompt = '自定义策展正文'
    state.promptLibrary.defaultPresetId = 'curator'
    await gateway.handleRequest({ type: 'prompts.save', library: state.promptLibrary })
    const after = await gateway.handleRequest({ type: 'session.new' })
    assert.equal(after.session.prompt.systemPrompt, '自定义策展正文')
    assert.equal((await gateway.handleRequest({ type: 'session.load', id: before.session.id })).session.prompt.presetId, 'general')
    await gateway.handleRequest({ type: 'session.prompt.set', sessionId: before.session.id, presetId: 'listening' })
    await gateway.registerSettingsPanel()
    await fake.commands.get('echo-assistant.settings.save')({ ...PROFILE })
    assert.equal((await gateway.handleRequest({ type: 'state' })).promptLibrary.defaultPresetId, 'curator')
    assert.equal((await gateway.handleRequest({ type: 'session.load', id: after.session.id })).session.prompt.systemPrompt, '自定义策展正文')
  })
})

test('真正缺少 prompt 的旧会话兼容读取；空的新会话也持久保存默认角色快照', async () => {
  await withGateway(async (gateway, fake) => {
    const state = await gateway.handleRequest({ type: 'state' })
    state.promptLibrary.defaultPresetId = 'curator'
    await gateway.handleRequest({ type: 'prompts.save', library: state.promptLibrary })
    const fresh = await gateway.handleRequest({ type: 'session.new' })
    await mkdir(join(fake.context.storagePath, 'sessions'), { recursive: true })
    await writeFile(join(fake.context.storagePath, 'sessions', 'legacy_01.json'), JSON.stringify({ id: 'legacy_01', title: '旧版对话', messages: [{ role: 'user', content: [{ type: 'text', text: '保留的历史' }] }] }))
    const reopened = createGateway(fake.context)
    await reopened.initialize()
    try {
      const legacy = await reopened.handleRequest({ type: 'session.load', id: 'legacy_01' })
      assert.equal(legacy.session.prompt.presetId, 'general')
      assert.equal(legacy.session.messages[0].content[0].text, '保留的历史')
      assert.equal((await reopened.handleRequest({ type: 'session.load', id: fresh.session.id })).session.prompt.presetId, 'curator')
    } finally { await reopened.dispose() }
  })
})

test('运行期间修改角色只影响下一轮，不修改正在等待响应的请求', async () => {
  const original = globalThis.fetch, calls = []
  let complete
  globalThis.fetch = async (_url, init) => {
    calls.push(JSON.parse(init.body))
    if (calls.length === 1) return new Promise(resolve => { complete = () => resolve(stream([{ choices: [{ delta: { content: '完成' } }] }, '[DONE]'])) })
    return stream([{ choices: [{ delta: { content: '下一轮' } }] }, '[DONE]'])
  }
  try {
    await withGateway(async (gateway, fake) => {
      await gateway.handleRequest({ type: 'profile.save', profile: PROFILE })
      const first = await gateway.handleRequest({ type: 'chat.send', text: '开始' })
      await until(() => complete)
      await gateway.handleRequest({ type: 'session.prompt.set', sessionId: first.sessionId, prompt: { name: '测试角色', systemPrompt: '以后只讨论爵士音乐' } })
      complete()
      await until(() => fake.events.some(event => event.value.type === 'done'))
      assert.doesNotMatch(calls[0].messages[0].content, /以后只讨论爵士音乐/)
      await gateway.handleRequest({ type: 'chat.send', sessionId: first.sessionId, text: '继续' })
      await until(() => fake.events.filter(event => event.value.type === 'done').length === 2)
      assert.match(calls[1].messages[0].content, /以后只讨论爵士音乐/)
    })
  } finally { globalThis.fetch = original }
})
