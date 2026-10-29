/**
 * 回声助手 gateway — runs in the plugin utility process.
 *
 * Two surfaces:
 *  - v1-3 settingsPanel form for quick API config (host-rendered)
 *  - v4 experience relay: the chat iframe calls `plugin.request` and this
 *    gateway answers (chat / sessions / profiles / confirmations / usage),
 *    streaming progress back through `twilight.experience.emit`.
 */
import { createProvider, normalizeProfile, maskedProfile, listModels } from './agent/providers.mjs'
import { createTools } from './agent/tools.mjs'
import { createHistory, deriveTitle } from './agent/history.mjs'
import { createUsageTracker } from './agent/usage.mjs'
import { createAgent } from './agent/agent.mjs'
import {
  SETTINGS_COMMAND,
  SETTINGS_SAVE_COMMAND,
  buildConfigForm,
  applyConfigFormValues
} from './agent/settingsForm.mjs'

import { defaultPromptLibrary, normalizePromptLibrary, promptSnapshot } from './agent/prompts.mjs'
import { scanLibrary, reportSummary } from './agent/scans.mjs'
import { abortable, throwIfAborted } from './agent/runtime.mjs'

const PROMPTS_KEY = 'assistant.prompts'
const CONFIG_KEY = 'assistant.config'
const EVENT_NAME = 'chat'

export function createGateway(context) {
  const history = createHistory({ storagePath: context.storagePath })
  const usage = createUsageTracker({ storagePath: context.storagePath })
  /** cardId -> { resolve, sessionId } */
  const pendingConfirms = new Map()
  /** sessionId -> { session, controller } */
  const activeRuns = new Map()
  /** sessionId -> session object cache */
  const sessionCache = new Map()
  const lastRuns = new Map()
  let promptLibrary = defaultPromptLibrary()
  let config = { profiles: [], activeProfileId: null }
  let ready = false

  const offCommands = []

  function runSnapshot(run) {
    if (!run) return null
    return structuredClone({ id: run.id, sessionId: run.session.id, kind: run.kind, phase: run.phase, revision: run.revision,
      streaming: run.streaming, tools: run.tools, cards: run.cards, progress: run.progress, error: run.error, hadWrites: run.hadWrites })
  }
  function emit(sessionId, payload) {
    const run = activeRuns.get(sessionId)
    if (!run || run.finished) return
    if (run.controller.signal.aborted && !['message', 'card-resolved'].includes(payload.type)) return
    if (payload.type === 'step') { run.phase = 'generating'; run.streaming = '' }
    if (payload.type === 'delta') { run.phase = 'generating'; run.streaming += payload.text }
    if (payload.type === 'message' && payload.message.role === 'assistant') run.streaming = ''
    if (payload.type === 'tool') {
      run.phase = 'tool'
      let tool = run.tools.find(item => item.id === payload.id)
      if (!tool) { tool = { id: payload.id, name: payload.name }; run.tools.push(tool) }
      Object.assign(tool, { status: payload.status, error: payload.error })
    }
    if (payload.type === 'card') { run.phase = 'confirming'; run.cards.push({ card: payload.card, resolved: false }) }
    if (payload.type === 'card-resolved') {
      const entry = run.cards.find(item => item.card.id === payload.cardId)
      if (entry) Object.assign(entry, { resolved: true, approved: payload.approved, cancelled: payload.cancelled })
      run.phase = run.controller.signal.aborted ? 'stopping' : 'tool'
    }
    if (payload.type === 'progress') { run.phase = 'scanning'; run.progress = payload.progress }
    run.revision++
    context.twilight.experience?.emit(EVENT_NAME, { sessionId, runId: run.id, revision: run.revision, ...payload })
  }
  function broadcast(payload) { context.twilight.experience?.emit(EVENT_NAME, payload) }

  async function loadConfig() {
    const storedPrompts = await context.settings.get(PROMPTS_KEY)
    if (storedPrompts) promptLibrary = normalizePromptLibrary(storedPrompts)
    const stored = await context.settings.get(CONFIG_KEY)
    if (stored && typeof stored === 'object' && Array.isArray(stored.profiles)) {
      config = { profiles: stored.profiles, activeProfileId: stored.activeProfileId ?? null }
    }
  }

  async function persistConfig() {
    await context.settings.set(CONFIG_KEY, config)
  }

  function activeProfile() {
    return config.profiles.find((profile) => profile.id === config.activeProfileId) ?? config.profiles[0] ?? null
  }

  function confirmCard(sessionId, card, signal) {
    if (signal?.aborted) return Promise.resolve(false)
    return new Promise(resolve => {
      const cardId = 'c_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7)
      const settle = (approved, cancelled = false) => {
        if (!pendingConfirms.has(cardId)) return
        pendingConfirms.delete(cardId)
        signal?.removeEventListener('abort', onAbort)
        if (approved && activeRuns.has(sessionId)) activeRuns.get(sessionId).hadWrites = true
        emit(sessionId, { type: 'card-resolved', cardId, approved, cancelled })
        broadcast({ type: 'card-pending', count: pendingConfirms.size })
        resolve(approved)
      }
      const onAbort = () => settle(false, true)
      pendingConfirms.set(cardId, { resolve: settle, sessionId })
      signal?.addEventListener('abort', onAbort, { once: true })
      emit(sessionId, { type: 'card', card: { ...card, id: cardId } })
      broadcast({ type: 'card-pending', count: pendingConfirms.size })
    })
  }

  const tools = createTools({ context })
  const agent = createAgent({
    tools,
    emit,
    usage,
    getActiveProfile: activeProfile,
    createProviderCall: (profile) => createProvider(profile),
    confirmCard
  })

  async function ensureSession(sessionId) {
    if (sessionId && sessionCache.has(sessionId)) return sessionCache.get(sessionId)
    if (sessionId) {
      const loaded = await history.loadSession(sessionId)
      if (loaded) {
        loaded.prompt ??= promptSnapshot(promptLibrary, 'general')
        sessionCache.set(sessionId, loaded)
        return loaded
      }
    }
    const session = await history.createSession()
    session.prompt = promptSnapshot(promptLibrary)
    await history.saveSession(session)
    sessionCache.set(session.id, session)
    return session
  }

  async function refreshReports(session, signal) {
    const reports = session.messages.filter(message => message.report && !message.report.result.stale && message.report.result.libraryRevision !== undefined)
    if (!reports.length) return
    let revision, unavailable = false, changed = false
    try {
      const page = await abortable(context.twilight.library.queryTracks({ offset: 0, limit: 1 }), signal ?? AbortSignal.timeout(5000))
      revision = page.revision
      unavailable = revision === undefined
    } catch (error) {
      throwIfAborted(signal)
      unavailable = true
      context.logger.warn('无法核对报告对应的曲库版本：' + String(error))
    }
    for (const message of reports) {
      const report = message.report, result = report.result
      const stale = !unavailable && result.libraryRevision !== revision
      if (stale || Boolean(result.freshnessUnknown) !== unavailable) {
        result.freshnessUnknown = unavailable
        if (stale) { result.stale = true; result.complete = false }
        message.content = [{ type: 'text', text: `${reportSummary(report.kind, result)}\n报告时间：${report.createdAt}` }]
        changed = true
      }
    }
    if (changed) await history.saveSession(session)
  }

  async function startRun({ sessionId, text, kind = 'chat' }) {
    if (kind === 'chat' && (!text || typeof text !== 'string' || !text.trim())) throw new Error('消息不能为空')
    const profile = kind === 'chat' ? activeProfile() : null
    if (kind === 'chat' && !profile) throw new Error('尚未配置 AI 服务，请先在设置里添加 API 配置')
    if (!['chat', 'quality', 'duplicates'].includes(kind)) throw new Error('未知检查类型')
    const session = await ensureSession(sessionId)
    if (activeRuns.has(session.id)) throw new Error('这一会话正在运行，请先等待或点停止')
    const message = { id: 'm_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8), role: 'user', content: [{ type: 'text', text: kind === 'chat' ? text.trim().slice(0, 8000) : kind === 'quality' ? '检查我的曲库质量' : '查找曲库中的疑似重复' }] }
    session.messages.push(message)
    if (session.title === '新对话') session.title = deriveTitle(message.content[0].text)
    const run = { id: 'r_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8), session, kind,
      controller: new AbortController(), prompt: structuredClone(session.prompt), phase: 'preparing', revision: 0, streaming: '', tools: [], cards: [], progress: null, error: null, hadWrites: false }
    activeRuns.set(session.id, run)
    lastRuns.delete(session.id)
    emit(session.id, { type: 'start', title: session.title, message, kind })
    run.promise = executeRun(run, profile ? structuredClone(profile) : null)
    return { sessionId: session.id, title: session.title, session: transportSession(session), run: runSnapshot(run) }
  }

  async function executeRun(run, profile) {
    let error = null
    try {
      await history.saveSession(run.session)
      if (run.kind === 'chat') {
        throwIfAborted(run.controller.signal)
        await refreshReports(run.session, run.controller.signal)
        await agent.run({ session: run.session, profile, prompt: run.prompt, signal: run.controller.signal })
      } else {
        const result = await scanLibrary({ library: context.twilight.library, kind: run.kind, signal: run.controller.signal,
          onProgress: progress => emit(run.session.id, { type: 'progress', progress }) })
        const createdAt = new Date().toISOString()
        run.session.messages.push({ id: 'report_' + run.id, role: 'assistant', content: [{ type: 'text', text: `${reportSummary(run.kind, result)}\n报告时间：${createdAt}` }],
          report: { kind: run.kind, result, createdAt } })
      }
    } catch (caught) {
      if (!run.controller.signal.aborted) error = caught instanceof Error ? caught.message : String(caught)
    }
    for (const pending of pendingConfirms.values()) if (pending.sessionId === run.session.id) pending.resolve(false, true)
    run.phase = error ? 'error' : run.controller.signal.aborted ? 'cancelled' : 'done'
    run.error = error
    run.streaming = ''
    for (const tool of run.tools) if (tool.status === 'start') tool.status = 'cancelled'
    try { await history.saveSession(run.session) } catch (caught) {
      run.error = '会话保存失败：' + (caught instanceof Error ? caught.message : String(caught))
      run.phase = 'error'
    }
    run.finished = true
    run.revision++
    activeRuns.delete(run.session.id)
    lastRuns.set(run.session.id, run)
    context.twilight.experience?.emit(EVENT_NAME, { sessionId: run.session.id, runId: run.id, revision: run.revision,
      type: 'done', error: run.error, run: runSnapshot(run), session: transportSession(run.session) })
  }

  async function handleRequest(request) {
    if (!request || typeof request !== 'object' || typeof request.type !== 'string') {
      throw new Error('无效请求')
    }
    switch (request.type) {
      case 'state': {
        const profiles = config.profiles.map(maskedProfile)
        return {
          ready,
          profiles,
          activeProfileId: activeProfile()?.id ?? null,
          sessions: await history.listSessions(),
          runningSessionIds: [...activeRuns.keys()],
          runs: [...lastRuns.values(), ...activeRuns.values()].map(runSnapshot),
          promptLibrary,
          promptDefaults: defaultPromptLibrary(),
          usage: await usage.summary()
        }
      }
      case 'profile.save': {
        const incoming = { ...(request.profile ?? {}) }
        const existing = config.profiles.find((profile) => profile.id === incoming.id)
        if (existing && !String(incoming.apiKey ?? '').trim()) {
          incoming.apiKey = existing.apiKey
        }
        const normalized = normalizeProfile(incoming)
        const index = config.profiles.findIndex((profile) => profile.id === normalized.id)
        if (index >= 0) config.profiles[index] = normalized
        else config.profiles.push(normalized)
        if (!config.activeProfileId) config.activeProfileId = normalized.id
        await persistConfig()
        return { profiles: config.profiles.map(maskedProfile), activeProfileId: activeProfile()?.id ?? null }
      }
      case 'profile.delete': {
        const id = String(request.id ?? '')
        config.profiles = config.profiles.filter((profile) => profile.id !== id)
        if (config.activeProfileId === id) config.activeProfileId = config.profiles[0]?.id ?? null
        await persistConfig()
        return { profiles: config.profiles.map(maskedProfile), activeProfileId: config.activeProfileId }
      }
      case 'profile.activate': {
        const id = String(request.id ?? '')
        if (!config.profiles.some((profile) => profile.id === id)) throw new Error('配置不存在')
        config.activeProfileId = id
        await persistConfig()
        return { activeProfileId: id }
      }
      case 'session.new': {
        const session = await ensureSession()
        return { session: transportSession(session) }
      }
      case 'session.load': {
        const session = await ensureSession(String(request.id ?? ''))
        if (!session) throw new Error('会话不存在')
        await refreshReports(session)
        return { session: transportSession(session), run: runSnapshot(activeRuns.get(session.id) ?? lastRuns.get(session.id)) }
      }
      case 'session.delete': {
        const id = String(request.id ?? '')
        if (activeRuns.has(id)) throw new Error('会话正在回复中，无法删除')
        sessionCache.delete(id)
        lastRuns.delete(id)
        await history.deleteSession(id)
        return { sessions: await history.listSessions() }
      }
      case 'session.list':
        return { sessions: await history.listSessions() }
      case 'chat.send':
        return await startRun({ sessionId: request.sessionId, text: request.text })
      case 'workflow.start':
        if (!['quality', 'duplicates'].includes(request.kind)) throw new Error('未知检查类型')
        return startRun({ sessionId: request.sessionId, kind: request.kind })
      case 'prompts.save': {
        const next = normalizePromptLibrary(request.library)
        await context.settings.set(PROMPTS_KEY, next)
        promptLibrary = next
        return { promptLibrary }
      }
      case 'session.prompt.set': {
        const session = await ensureSession(request.sessionId)
        if (request.prompt) {
          const clean = normalizePromptLibrary({ presets: [{ id: 'custom', name: request.prompt.name, systemPrompt: request.prompt.systemPrompt }] }).presets[0]
          session.prompt = { presetId: request.prompt.presetId || 'custom', name: clean.name, systemPrompt: clean.systemPrompt }
        } else session.prompt = promptSnapshot(promptLibrary, request.presetId)
        await history.saveSession(session)
        return { session: transportSession(session) }
      }
      case 'chat.confirm': {
        const cardId = String(request.cardId ?? '')
        const pending = pendingConfirms.get(cardId)
        if (!pending) return { resolved: false }
        pending.resolve(request.approved === true)
        return { resolved: true }
      }
      case 'chat.cancel': {
        const sessionId = String(request.sessionId ?? '')
        const run = activeRuns.get(sessionId)
        if (!run || request.runId && request.runId !== run.id) return { cancelled: false, run: runSnapshot(run ?? lastRuns.get(sessionId)) }
        run.phase = 'stopping'
        run.revision++
        run.controller.abort(new Error('用户停止了本轮操作'))
        return { cancelled: true, run: runSnapshot(run) }
      }
      case 'usage.summary':
        return await usage.summary()
      case 'models.list': {
        // The iframe cannot fetch; probe the endpoint here with the values the
        // form currently holds. Editing an existing profile without retyping
        // the key reuses the stored secret.
        const protocol = String(request.protocol ?? 'openai-chat')
        const baseUrl = typeof request.baseUrl === 'string' ? request.baseUrl : ''
        const profileId = typeof request.profileId === 'string' ? request.profileId : ''
        const stored = config.profiles.find((profile) => profile.id === profileId)
        let apiKey = typeof request.apiKey === 'string' ? request.apiKey.trim() : ''
        if (!apiKey && stored) apiKey = stored.apiKey ?? ''
        let host = ''
        try {
          host = new URL(baseUrl || 'https://invalid').host
        } catch {
          host = 'invalid'
        }
        context.logger.info(`获取模型列表：${host}（${protocol}）`)
        const startedAt = Date.now()
        try {
          // Hard backstop: even if the proxy fetch ignored its abort signal, the
          // chat panel must never sit on "获取中" longer than this.
          const result = await Promise.race([
            listModels({ protocol, baseUrl, apiKey }),
            new Promise((_, reject) =>
              setTimeout(
                () => reject(new Error('获取模型超时（25 秒）。请检查 API 地址是否可达，或应用的代理设置是否覆盖该域名。')),
                25000
              ).unref?.()
            )
          ])
          context.logger.info(
            `获取模型成功：${host}，${result.models.length} 个，${Date.now() - startedAt}ms`
          )
          return result
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          context.logger.warn(`获取模型失败：${host}，${Date.now() - startedAt}ms，${message}`)
          throw error
        }
      }
      default:
        throw new Error(`未知请求：${request.type}`)
    }
  }

  async function initialize() {
    await loadConfig()
    ready = true
  }

  return {
    handleRequest,
    initialize,
    async dispose() {
      const runs = [...activeRuns.values()]
      for (const run of runs) run.controller.abort(new Error('插件已停用'))
      for (const pending of pendingConfirms.values()) pending.resolve(false, true)
      await Promise.allSettled(runs.map(run => run.promise))
      activeRuns.clear()
      pendingConfirms.clear()
      sessionCache.clear()
      lastRuns.clear()
    },
    /** v1-3 settings panel wiring */
    registerSettingsPanel: async () => {
      await context.twilight.ui.register({
        id: 'echo-assistant-titlebar',
        kind: 'titleBarButton',
        title: '回声助手',
        description: 'AI 助手：调设置、理曲库、控制播放'
      })
      await context.twilight.ui.register({
        id: 'echo-assistant-settings',
        kind: 'settingsPanel',
        title: '回声助手',
        description: 'AI 助手的 API 接入配置',
        icon: 'pi pi-sparkles',
        command: SETTINGS_COMMAND
      })
      offCommands.push(
        context.twilight.ui.onCommand(SETTINGS_COMMAND, async () => buildConfigForm(config)),
        context.twilight.ui.onCommand(SETTINGS_SAVE_COMMAND, (...args) =>
          (async () => {
            config = applyConfigFormValues(config, args[0])
            await persistConfig()
            return { message: '已保存', form: buildConfigForm(config) }
          })()
        )
      )
    },
    unregisterCommands() {
      while (offCommands.length) offCommands.pop()()
    }
  }
}

function transportSession(session) {
  return {
    id: session.id,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    prompt: session.prompt,
    messages: session.messages.map((message, index) => ({
      id: message.id ?? `legacy_${index}`,
      report: message.report,
      interrupted: message.interrupted,
      role: message.role,
      content: message.content,
      toolCalls: message.toolCalls,
      toolCallId: message.toolCallId,
      name: message.name,
      implicit: message.implicit
    }))
  }
}

let gateway = null

export async function activate(context) {
  gateway = createGateway(context)
  await gateway.initialize()
  await gateway.registerSettingsPanel()
  // API v4 hosts only; older hosts simply never reach this plugin's chat page.
  context.twilight.experience?.onRequest((request) => gateway.handleRequest(request))
  context.logger.info('回声助手已启动')
}

export async function deactivate() {
  gateway?.unregisterCommands()
  await gateway?.dispose()
  gateway = null
}
