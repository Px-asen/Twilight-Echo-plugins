import test from 'node:test'
import assert from 'node:assert/strict'
import { ConversationStore } from '../src/store.ts'
import { createBridge } from '../src/bridge.ts'

const makeSession = id => ({ id, title: '对话', prompt: {}, messages: [] })
const makeRun = (id, revision = 1, phase = 'preparing') => ({ id, sessionId: 's1', kind: 'chat', revision, phase, streaming: '', tools: [], cards: [], progress: null, error: null })
test('done 先于 send 响应时不会被旧快照恢复成回答中；迟到事件隔离', () => {
  const store = new ConversationStore()
  store.hydrate({ session: makeSession('s1') })
  store.event({ type: 'start', sessionId: 's1', runId: 'r1', kind: 'chat', revision: 1 })
  store.event({ type: 'delta', sessionId: 's1', runId: 'r1', text: '答案', revision: 2 })
  store.event({ type: 'done', sessionId: 's1', runId: 'r1', revision: 3, run: makeRun('r1', 3, 'done'), session: makeSession('s1') })
  store.hydrate({ session: makeSession('s1'), run: makeRun('r1') })
  assert.equal(store.runs.get('s1').phase, 'done')
  store.event({ type: 'start', sessionId: 's1', runId: 'r2', kind: 'chat', revision: 1 })
  store.event({ type: 'delta', sessionId: 's1', runId: 'r1', text: '过期输出', revision: 99 })
  store.snapshot(makeRun('r1', 99, 'generating'))
  assert.equal(store.runs.get('s1').id, 'r2'); assert.equal(store.runs.get('s1').streaming, '')
})
test('重新打开恢复流片段与确认卡，重复 delta 不重复追加', () => {
  const store = new ConversationStore(), run = makeRun('r1', 4, 'confirming')
  run.streaming = '部分'; run.cards = [{ card: { id: 'c1' }, resolved: false }]
  store.hydrate({ session: makeSession('s1'), run })
  store.event({ type: 'delta', sessionId: 's1', runId: 'r1', text: '重复', revision: 4 })
  assert.equal(store.runs.get('s1').streaming, '部分'); assert.equal(store.runs.get('s1').cards[0].resolved, false)
})
test('start 即时提交用户消息，较早的 send 响应不会让消息消失', () => {
  const store = new ConversationStore(), message = { id: 'm1', role: 'user', content: [{ type: 'text', text: '开始' }] }
  store.hydrate({ session: makeSession('s1') })
  store.event({ type: 'start', sessionId: 's1', runId: 'r1', kind: 'chat', revision: 1, title: '开始', message })
  store.event({ type: 'delta', sessionId: 's1', runId: 'r1', text: '正在生成', revision: 2 })
  store.hydrate({ session: { ...makeSession('s1'), messages: [message] }, run: makeRun('r1') })
  assert.equal(store.sessions.get('s1').title, '开始')
  assert.equal(store.sessions.get('s1').messages[0].id, 'm1')
  assert.equal(store.runs.get('s1').streaming, '正在生成')
})
test('真实 MessagePort 封装解包，并能请求宿主减少动态效果设置', async () => {
  const previous = globalThis.window
  const handlers = new Map(), parent = { postMessage() {} }
  globalThis.window = { parent, addEventListener: (name, fn) => handlers.set(name, fn), removeEventListener: name => handlers.delete(name) }
  const channel = new MessageChannel()
  let bridge
  try {
    const connection = createBridge()
    handlers.get('message')({ source: parent, data: { type: 'twilight-experience-connect', bridgeVersion: 2 }, ports: [channel.port1] })
    bridge = await connection
    const event = new Promise(resolve => bridge.onPluginEvent(resolve))
    channel.port2.postMessage({ event: 'plugin', value: { event: 'chat', value: { type: 'done', runId: 'r1', sessionId: 's1' } } })
    assert.equal((await event).type, 'done')
    channel.port2.onmessage = ({ data }) => { assert.equal(data.method, 'host.environment'); channel.port2.postMessage({ id: data.id, value: { reducedMotion: true } }) }
    assert.equal((await bridge.environment()).reducedMotion, true)
  } finally { bridge?.dispose(); channel.port2.close(); globalThis.window = previous }
})
