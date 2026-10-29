import { createBridge } from './bridge'
import { ConversationStore } from './store'
import { renderMarkdown } from './markdown'
import { el, button, icon, iconButton, field, sheet, closeModal, mountModals, setErrorHandler } from './dom'
import { settingsPanel } from './settings'
import { followAppearance } from './theme'
import { isActive, type AppSnapshot, type CardEntry, type Report, type Run, type Session, type SessionMessage, type Snapshot } from './types'

const store = new ConversationStore()
let bridge: Awaited<ReturnType<typeof createBridge>>
let data: AppSnapshot = { profiles: [], activeProfileId: null, sessions: [], runs: [], promptLibrary: { presets: [], shortcuts: [], defaultPresetId: 'general' }, promptDefaults: { presets: [], shortcuts: [], defaultPresetId: 'general' }, usage: { calls: 0, inputTokens: 0, outputTokens: 0, cost: 0 } }
let currentId = '', displayedId = '', ready = false, renderQueued = false, following = true, loadSequence = 0
let headerKey = '', toolsKey = '', cardsKey = '', liveKey = ''
const pending = new Set<string>()
const messages = new Map<string, { node: HTMLElement; content: string }>()
const app = document.getElementById('app')!
const toolLabels: Record<string, string> = { get_app_settings: '读取应用设置', update_app_settings: '修改应用设置', capture_screenshot: '观察当前界面', query_library: '查询本地曲库', get_tracks: '读取曲目详情', patch_track_metadata: '修正曲目信息', get_cover: '检查封面', list_playlists: '读取歌单', create_playlist: '创建歌单', add_to_playlist: '追加歌单', play_tracks: '开始播放', player_control: '控制播放', get_playback_info: '读取播放状态', find_duplicates: '查找重复', library_quality_report: '检查曲库质量' }
const session = (): Session | undefined => store.sessions.get(currentId)
const run = (): Run | undefined => store.runs.get(currentId)
const active = (): boolean => isActive(run()) || pending.has(currentId || 'new')
async function request<T>(payload: unknown): Promise<T> { return await bridge.request(payload) as T }
let noticeTimer: ReturnType<typeof setTimeout>
function notice(error: unknown): void {
  noticeEl.textContent = error instanceof Error ? error.message : String(error); noticeEl.hidden = false
  clearTimeout(noticeTimer); noticeTimer = setTimeout(() => { noticeEl.hidden = true }, 6500)
}
setErrorHandler(notice)
function draftKey(id = currentId): string { return `echo:draft:${id || 'new'}` }
function readDraft(): string { return sessionStorage.getItem(draftKey()) ?? '' }
function setDraft(text: string): void { textarea.value = text; sessionStorage.setItem(draftKey(), text); resizeInput(); updateComposer() }
function fillDraft(text: string): void { setDraft(text); closeModal(); closeTasks(); textarea.focus() }
function resizeInput(): void { textarea.style.height = 'auto'; textarea.style.height = `${Math.min(170, textarea.scrollHeight)}px` }
function schedule(): void { if (!renderQueued) { renderQueued = true; requestAnimationFrame(() => { renderQueued = false; render() }) } }

// Stream events never replace the composer, modal forms or scroll container.
app.textContent = ''
const header = el('header', 'topbar')
const scroller = el('main', 'chat-scroll'); scroller.setAttribute('aria-label', '对话记录')
const timeline = el('div', 'timeline'), live = el('section', 'live')
const status = el('div', 'run-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite')
const tools = el('details', 'tool-details'), cards = el('div', 'confirmations'), streamBody = el('div', 'markdown streaming')
live.append(status, tools, cards, streamBody); scroller.append(timeline, live)
const latest = button('回到最新', 'latest', () => { following = true; scroller.scrollTop = scroller.scrollHeight }, 'down'); latest.hidden = true
const composer = el('footer', 'composer'), draftTools = el('div', 'composer-tools')
const taskButton = button('音乐任务', 'quiet-btn', () => toggleTasks(), 'plus')
const shortcutButton = button('快捷指令', 'quiet-btn', () => openShortcuts(), 'playlist')
const composerHint = el('span', 'keyboard-hint', 'Ctrl ↵ 发送')
draftTools.append(taskButton, shortcutButton, composerHint)
const inputWrap = el('div', 'input-wrap'), textarea = el('textarea', 'composer-input')
textarea.rows = 1; textarea.setAttribute('aria-label', '输入消息')
textarea.addEventListener('input', () => { sessionStorage.setItem(draftKey(), textarea.value); resizeInput(); updateComposer() })
textarea.addEventListener('keydown', event => {
  if (!event.isComposing && event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); if (!active()) void sendMessage().catch(notice) }
})
const sendButton = button('', 'send-btn', () => active() ? stopRun() : sendMessage())
inputWrap.append(textarea, sendButton); composer.append(draftTools, inputWrap)
const noticeEl = el('div', 'notice'); noticeEl.hidden = true; noticeEl.setAttribute('role', 'alert')
const modalRoot = el('div', 'modal-root'), taskRoot = el('div', 'task-popover'); taskRoot.hidden = true
mountModals(modalRoot)
app.append(header, scroller, latest, taskRoot, composer, noticeEl, modalRoot)
const openSettings = settingsPanel({ data: () => data, request, refresh, session, ensureSession, schedule, notice })
scroller.addEventListener('scroll', () => { following = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 64; latest.hidden = following })
document.addEventListener('click', event => { if (!taskRoot.contains(event.target as Node) && !taskButton.contains(event.target as Node)) closeTasks() })
document.addEventListener('keydown', event => { if (event.key === 'Escape') closeTasks() })

async function refresh(): Promise<void> {
  data = await request<AppSnapshot>({ type: 'state' })
  for (const snapshot of data.runs) store.snapshot(snapshot)
  if (!currentId && data.sessions.length) await loadSession(data.sessions[0].id)
  schedule()
}
async function loadSession(id: string): Promise<void> {
  const order = ++loadSequence
  const result = await request<Snapshot>({ type: 'session.load', id }); store.hydrate(result)
  if (order !== loadSequence) return
  currentId = result.session.id; following = true; setDraft(readDraft()); closeModal(); schedule()
}
async function ensureSession(): Promise<Session> {
  if (session()) return session()!
  const oldDraft = textarea.value
  const result = await request<Snapshot>({ type: 'session.new' }); store.hydrate(result); currentId = result.session.id
  if (textarea.value === oldDraft) setDraft(oldDraft)
  sessionStorage.removeItem(draftKey('')); schedule(); return result.session
}
async function newSession(): Promise<void> {
  const result = await request<Snapshot>({ type: 'session.new' })
  ++loadSequence; store.hydrate(result); currentId = result.session.id; following = true
  setDraft(readDraft()); closeModal(); closeTasks(); await refresh(); textarea.focus()
}
async function start(kind: 'chat' | 'quality' | 'duplicates', text?: string): Promise<void> {
  if (active() || !ready) return
  if (kind === 'chat' && !data.profiles.length) { openSettings('api'); notice('先接入一个 AI 服务，草稿会保留'); return }
  const initialKey = currentId || 'new'; pending.add(initialKey); updateComposer()
  let target: Session | undefined
  try {
    target = await ensureSession(); pending.add(target.id)
    const result = await request<Snapshot>(kind === 'chat' ? { type: 'chat.send', sessionId: target.id, text } : { type: 'workflow.start', sessionId: target.id, kind })
    store.hydrate(result)
    if (currentId === target.id && kind === 'chat' && textarea.value.trim() === text) setDraft('')
    if (currentId === target.id) following = true
  } finally { pending.delete(initialKey); if (target) pending.delete(target.id); schedule() }
}
async function sendMessage(): Promise<void> { const text = textarea.value.trim(); if (text) await start('chat', text) }
async function stopRun(): Promise<void> {
  const current = run()
  if (!current || !isActive(current) || current.phase === 'stopping') return
  current.phase = 'stopping'; updateComposer(); schedule()
  try {
    const result = await request<{ cancelled: boolean; run: Run | null }>({ type: 'chat.cancel', sessionId: current.sessionId, runId: current.id })
    if (result.run) store.snapshot(result.run)
    else { store.hydrate(await request<Snapshot>({ type: 'session.load', id: current.sessionId })); current.phase = 'cancelled' }
  } catch (error) {
    try { store.hydrate(await request<Snapshot>({ type: 'session.load', id: current.sessionId })) } catch { current.phase = 'error'; current.error = String(error) }
    notice(error)
  }
  schedule()
}
function updateComposer(): void {
  const busy = active(), stopping = run()?.phase === 'stopping'
  sendButton.replaceChildren(icon(busy ? 'stop' : 'send')); sendButton.className = `send-btn${busy ? ' stopping-control' : ''}`
  sendButton.title = stopping ? '正在停止' : busy ? '停止本轮操作' : '发送消息'; sendButton.setAttribute('aria-label', sendButton.title)
  sendButton.disabled = !ready || stopping || (busy && !isActive(run())) || (!busy && !textarea.value.trim())
  textarea.placeholder = busy ? '可以先写下一条，完成后发送…' : '聊聊音乐，或交给我一个任务…'
  taskButton.disabled = busy || !ready; shortcutButton.disabled = !ready; composerHint.textContent = busy ? '草稿会保留' : 'Ctrl ↵ 发送'
}
function render(): void {
  const switched = displayedId !== currentId
  if (switched) { displayedId = currentId; messages.clear(); timeline.textContent = ''; following = true; toolsKey = ''; cardsKey = ''; liveKey = '' }
  renderHeader(); renderMessages(switched); renderLive(); updateComposer()
  if (following) scroller.scrollTop = scroller.scrollHeight
  latest.hidden = following
}
function renderHeader(): void {
  const current = session(), key = JSON.stringify([current?.title, current?.prompt, data.activeProfileId, data.profiles, data.promptLibrary.presets])
  if (key === headerKey) return
  headerKey = key; header.textContent = ''
  const row = el('div', 'header-main'), title = el('div', 'conversation-title', current?.title || '音乐与灵感'); title.title = title.textContent!
  const actions = el('div', 'header-actions'); actions.append(iconButton('历史对话', 'history', openHistory), iconButton('新对话', 'plus', newSession), iconButton('助手设置', 'settings', () => openSettings('api'))); row.append(title, actions)
  const controls = el('div', 'header-controls')
  const model = el('select', 'compact-select model-select'); model.setAttribute('aria-label', 'AI 配置')
  if (!data.profiles.length) { const option = el('option', '', '接入 AI 服务'); option.value = ''; model.append(option) }
  for (const profile of data.profiles) { const option = el('option', '', profile.label); option.value = profile.id; option.selected = data.activeProfileId === profile.id; model.append(option) }
  model.title = data.profiles.find(item => item.id === data.activeProfileId)?.model || '设置 API 地址、密钥与模型'
  model.addEventListener('pointerdown', () => { if (!data.profiles.length) openSettings('api') })
  model.addEventListener('change', () => { void request({ type: 'profile.activate', id: model.value }).then(refresh).catch(notice) })
  const role = el('select', 'compact-select role-select'); role.setAttribute('aria-label', '助手角色')
  const prompt = current?.prompt, modified = prompt && !data.promptLibrary.presets.some(item => item.id === prompt.presetId && item.systemPrompt === prompt.systemPrompt && item.name === prompt.name)
  if (modified) { const option = el('option', '', `${prompt.name} · 本会话`); option.value = 'custom'; option.selected = true; role.append(option) }
  for (const preset of data.promptLibrary.presets) { const option = el('option', '', preset.name); option.value = preset.id; option.selected = !modified && preset.id === (prompt?.presetId || data.promptLibrary.defaultPresetId); role.append(option) }
  role.addEventListener('change', () => { const id = role.value; void (async () => { const target = await ensureSession(); const result = await request<Snapshot>({ type: 'session.prompt.set', sessionId: target.id, presetId: id }); target.prompt = result.session.prompt; schedule() })().catch(notice) })
  controls.append(model, el('span', 'control-divider'), role, iconButton('编辑角色提示词', 'edit', () => openSettings('roles'))); header.append(row, controls)
}
function renderMessages(switched: boolean): void {
  const visible = session()?.messages.filter(message => !message.implicit && message.role !== 'tool') ?? []
  if (!visible.length) {
    const welcomeKey = `${ready}:${data.profiles.length}:${active()}`
    if (timeline.querySelector<HTMLElement>('.welcome')?.dataset.key !== welcomeKey) { timeline.textContent = ''; messages.clear(); const node = welcome(); node.dataset.key = welcomeKey; timeline.append(node) }
    return
  }
  timeline.querySelector('.welcome')?.remove()
  for (const message of visible) {
    const content = JSON.stringify(message), previous = messages.get(message.id)
    if (previous?.content === content) continue
    const node = renderMessage(message); if (!switched && !previous) node.classList.add('arrive')
    if (previous) previous.node.replaceWith(node); else timeline.append(node)
    messages.set(message.id, { node, content })
  }
}
function renderMessage(message: SessionMessage): HTMLElement {
  const text = message.content?.filter(block => block.type === 'text').map(block => block.text ?? '').join('\n') || ''
  const row = el('article', `message ${message.role}`); row.dataset.messageId = message.id
  if (message.role === 'user') { row.append(el('div', 'user-bubble', text)); return row }
  if (message.report) { row.append(renderReport(message.report)); return row }
  const label = el('div', 'assistant-label'); label.append(icon('sound'), el('span', '', '回声'))
  const body = el('div', 'markdown'); body.innerHTML = renderMarkdown(text); row.append(label)
  if (text) row.append(body)
  if (message.toolCalls?.length) row.append(el('div', 'message-tool-note', message.toolCalls.map(call => toolLabels[call.name] || call.name).join(' · ')))
  if (message.interrupted) row.append(el('span', 'muted small', '回答已中断'))
  if (text) row.append(iconButton('复制回复', 'copy', () => copyText(text))); return row
}
function copyText(text: string): void {
  const input = el('textarea', 'copy-buffer'); input.value = text; document.body.append(input); input.select()
  const copied = document.execCommand('copy'); input.remove(); textarea.focus()
  if (!copied) throw new Error('复制失败，请选中文字后复制'); notice('已复制')
}
function taskDefinitions(): Array<{ id: string; name: string; hint: string; glyph: string; action: () => unknown }> {
  return [
    { id: 'quality', name: '曲库体检', hint: '音质与信息完整度', glyph: 'quality', action: () => start('quality') },
    { id: 'duplicates', name: '查找重复', hint: '对比疑似重复的曲目', glyph: 'duplicates', action: () => start('duplicates') },
    { id: 'playlist', name: '主题歌单', hint: '为此刻挑选音乐', glyph: 'playlist', action: openPlaylist },
    { id: 'settings', name: '设置建议', hint: '让聆听更适合你', glyph: 'settings', action: () => fillDraft('先读取当前播放状态和应用设置，给出 3 项有依据的声音或界面调整建议。说明理由，修改前让我确认，不自动提高音量。') }
  ]
}
function taskCard(task: ReturnType<typeof taskDefinitions>[number]): HTMLElement {
  const card = button('', 'workflow-card', () => { closeTasks(); return task.action() }); card.dataset.task = task.id
  const label = el('div'); label.append(el('strong', '', task.name), el('span', '', task.hint)); card.append(icon(task.glyph), label); card.disabled = active() || !ready; return card
}
function welcome(): HTMLElement {
  const node = el('section', 'welcome'), emblem = el('div', 'welcome-emblem'); emblem.append(icon('sound'))
  node.append(emblem, el('h1', '', '从你的音乐库开始'), el('p', 'welcome-hint', '检查、整理，或为此刻挑一份歌单。'))
  const grid = el('div', 'workflow-grid'); for (const task of taskDefinitions()) grid.append(taskCard(task)); node.append(grid)
  if (!data.profiles.length) node.append(button('接入 AI，解锁策展与建议', 'setup-link', () => openSettings('api'), 'arrow'), el('p', 'local-note', '曲库检查在本地运行，无需 API。'))
  else node.append(el('p', 'local-note', '检查结果与后续分析都保存在这段对话里。'))
  return node
}
function closeTasks(): void { taskRoot.hidden = true; taskButton.setAttribute('aria-expanded', 'false') }
function toggleTasks(): void {
  if (!taskRoot.hidden) { closeTasks(); return }
  taskRoot.textContent = ''; for (const task of taskDefinitions()) taskRoot.append(taskCard(task)); taskRoot.hidden = false; taskButton.setAttribute('aria-expanded', 'true')
}
function renderReport(report: Report): HTMLElement {
  const r = report.result, quality = report.kind === 'quality', card = el('section', 'report-card'); card.dataset.report = report.kind
  const heading = el('div', 'report-heading'); heading.append(icon(quality ? 'quality' : 'duplicates'), el('h2', '', quality ? '曲库体检' : '重复检查'))
  heading.append(el('span', `badge ${r.complete ? 'success' : 'warning'}`, r.cancelled ? '部分结果 · 已停止' : r.stale ? '结果已过期' : r.complete ? '检查完成' : '部分结果')); card.append(heading, el('p', 'report-scope', `已检查 ${r.scanned.toLocaleString()} / ${r.libraryTotal.toLocaleString()} 首曲目`))
  if (r.stale) card.append(el('p', 'warning small', '曲库已变化，重新检查可获得当前结果。'))
  else if (r.freshnessUnknown) card.append(el('p', 'warning small', '暂时无法核对曲库是否变化。'))
  const date = el('time', 'report-date', new Date(report.createdAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })); date.dateTime = report.createdAt; card.append(date)
  if (quality) {
    const metrics = el('div', 'report-metrics')
    for (const [label, value] of [['无损曲目', r.lossless], ['高采样率', r.hiRes], ['缺失流派', r.missingGenre], ['缺失封面', r.missingCover], ['缺失 BPM', r.missingBpm]] as Array<[string, number | undefined]>) { const item = el('div', 'metric'); item.append(el('strong', '', String(value ?? 0)), el('span', '', label)); metrics.append(item) }
    card.append(metrics)
    const distribution = el('details', 'distribution'); distribution.append(el('summary', '', '格式、采样率与位深'))
    for (const [label, values] of [['格式', r.formats], ['采样率', r.sampleRates], ['位深', r.bitDepths]] as Array<[string, Record<string, number> | undefined]>) {
      distribution.append(el('h3', '', label)); if (!values || !Object.keys(values).length) distribution.append(el('p', 'muted small', '暂无数据'))
      for (const [key, count] of Object.entries(values ?? {}).sort((a, b) => b[1] - a[1])) {
        const row = el('div', 'distribution-row'); row.append(el('span', '', label === '采样率' ? Number(key) ? `${Number(key) / 1000} kHz` : '未知' : label === '位深' ? `${key} bit` : key))
        const meter = el('span', 'bar'), fill = el('i'); fill.style.width = `${r.scanned ? count / r.scanned * 100 : 0}%`; meter.append(fill); row.append(meter, el('span', '', String(count))); distribution.append(row)
      }
    }
    card.append(distribution)
  } else {
    card.append(el('div', 'duplicate-count', `${r.totalGroups ?? 0} 组疑似重复`), el('p', 'muted small', '对比版本后再决定处理方式，候选顺序不代表保留建议。'))
    for (const group of r.duplicateGroups ?? []) {
      const details = el('details', 'duplicate-group'); details.append(el('summary', '', `${group.keep.title || '未命名曲目'} · ${group.count ?? group.duplicates.length + 1} 首`))
      for (const track of [group.keep, ...group.duplicates]) { const row = el('div', 'duplicate-track'); row.append(el('strong', '', track.title || track.id), el('span', '', `${track.artist || '未知艺术家'}${track.album ? ` · ${track.album}` : ''}`), el('span', '', `${track.format || '未知格式'}${track.sampleRate ? ` · ${track.sampleRate / 1000} kHz` : ''}${track.bitDepth ? ` · ${track.bitDepth} bit` : ''} · ${track.duration}s`)); details.append(row) }
      if ((group.count ?? 0) > group.duplicates.length + 1) details.append(el('p', 'muted small', `此组展示前 ${group.duplicates.length + 1} 首，共 ${group.count} 首。`))
      card.append(details)
    }
    if (r.truncated) card.append(el('p', 'muted small', `共 ${r.totalGroups} 组，最多展示 40 组，每组最多 20 首。`))
  }
  const footer = el('div', 'report-footer'); footer.append(button('继续分析', 'btn subtle', () => {
    fillDraft(`请分析这段对话中报告时间为 ${report.createdAt} 的${quality ? '曲库体检' : '重复检查'}报告（扫描 ${r.scanned} / ${r.libraryTotal} 首），注意实际扫描范围和完成状态，给出有依据的整理建议；先列方案，不自动修改或删除。`)
    if (!data.profiles.length) { openSettings('api'); notice('接入 AI 后即可继续分析，报告与草稿已保留') }
  }, 'sound'), button('重新检查', 'quiet-btn', () => start(report.kind))); card.append(footer); return card
}
function renderLive(): void {
  const current = run(); if (!current) { live.hidden = true; return }; live.hidden = false
  const key = `${current.id}:${current.phase}:${JSON.stringify(current.progress)}:${current.error}`
  if (key !== liveKey) {
    liveKey = key; status.textContent = ''; status.className = `run-status phase-${current.phase}`
    const labels: Record<Run['phase'], string> = { preparing: '准备中', generating: '正在思考与生成', tool: '正在执行工具', confirming: '等待你的确认', scanning: '正在检查本地曲库', stopping: '正在停止', done: '已完成', cancelled: '已停止', error: '未能完成' }
    if (isActive(current)) { const wave = el('span', 'activity-wave'); wave.append(el('i'), el('i'), el('i')); status.append(wave) }
    else status.append(icon(current.phase === 'done' ? 'check' : current.phase === 'cancelled' ? 'stop' : 'close'))
    status.append(el('span', '', labels[current.phase])); if (current.progress) status.append(el('span', 'scan-count', `${current.progress.scanned.toLocaleString()} / ${current.progress.libraryTotal.toLocaleString()} 首`))
    if (current.phase === 'cancelled' && current.hadWrites) status.append(el('p', 'small', '已完成或已提交的修改会保留。'))
    if (current.error) {
      status.append(el('p', 'run-error', current.error), button('重试', 'btn small', () => {
        if (current.kind !== 'chat') return start(current.kind)
        const last = [...(session()?.messages ?? [])].reverse().find(message => message.role === 'user' && !message.implicit); if (last) fillDraft(last.content.map(block => block.text ?? '').join('\n'))
      }))
    }
  }
  const tk = JSON.stringify(current.tools)
  if (tk !== toolsKey) {
    toolsKey = tk; const open = tools.open; tools.textContent = ''; tools.open = open; tools.append(el('summary', '', `${current.tools.length} 个工具步骤`))
    for (const tool of current.tools) {
      const row = el('div', `tool-row ${tool.status}`); row.append(icon(tool.status === 'done' ? 'check' : tool.status === 'error' ? 'close' : 'sound'), el('span', '', toolLabels[tool.name] || tool.name), el('span', 'tool-state', tool.status === 'start' ? '执行中' : tool.status === 'done' ? '完成' : tool.status === 'error' ? '失败' : '已停止')); if (tool.error) row.append(el('p', 'run-error', tool.error)); tools.append(row)
    }
  }
  tools.hidden = !current.tools.length
  const ck = JSON.stringify(current.cards); if (ck !== cardsKey) { cardsKey = ck; cards.replaceChildren(...current.cards.map(renderCard)) }
  cards.hidden = !current.cards.length; streamBody.hidden = !current.streaming; if (current.streaming) streamBody.innerHTML = renderMarkdown(current.streaming)
}
function renderCard(entry: CardEntry): HTMLElement {
  const node = el('section', `confirm-card${entry.resolved ? ' resolved' : ''}`); node.dataset.cardId = entry.card.id
  node.append(el('div', 'eyebrow', entry.resolved ? '修改确认' : '需要你的确认'), el('h3', '', entry.card.title)); if (entry.card.reason) node.append(el('p', 'muted', entry.card.reason))
  const preview = entry.card.preview ?? {}, body = el('div', 'card-preview')
  for (const [key, value] of Object.entries(preview.patch ?? {})) { const row = el('div', 'preview-row'); row.append(el('span', 'muted', key), el('code', '', JSON.stringify(value))); body.append(row) }
  for (const patch of preview.patches ?? []) body.append(el('div', 'preview-row', `${patch.title}${patch.artist ? ` — ${patch.artist}` : ''}\n${Object.entries(patch.changes).map(([key, value]) => `${key} → ${String(value)}`).join('，')}`))
  for (const track of preview.tracks ?? []) body.append(el('div', 'preview-row', `${track.title}${track.artist ? ` — ${track.artist}` : ''}`)); if (preview.total) body.append(el('p', 'muted small', `共 ${preview.total} 首`)); node.append(body)
  if (entry.resolved) node.append(el('p', entry.approved ? 'success small' : 'muted small', entry.cancelled ? '本轮已停止，未执行此项确认' : entry.approved ? '已同意' : '已拒绝'))
  else {
    const footer = el('div', 'button-row')
    const resolve = async (approved: boolean) => {
      for (const b of footer.querySelectorAll('button')) b.disabled = true
      try { const result = await request<{ resolved: boolean }>({ type: 'chat.confirm', cardId: entry.card.id, approved }); if (!result.resolved) { store.hydrate(await request<Snapshot>({ type: 'session.load', id: currentId })); schedule() } }
      catch (error) { for (const b of footer.querySelectorAll('button')) b.disabled = false; throw error }
    }
    footer.append(button('拒绝', 'btn', () => resolve(false)), button('同意并执行', 'btn primary', () => resolve(true))); node.append(footer)
  }
  return node
}
function openPlaylist(): void {
  const { body } = sheet('为此刻挑一份歌单'); let scene = '', style = '', count = '20'
  body.append(el('p', 'muted', '从你的本地曲库中挑选，创建前会先给你看预览。'), field('场景或心情', scene, value => scene = value, { hint: '例如：雨天阅读、夜间驾驶、运动' }), field('偏爱的风格（可选）', style, value => style = value), field('曲目数量', count, value => count = value, { type: 'number' }))
  body.append(button('填入对话', 'btn primary full', () => {
    const amount = Number(count); if (!scene.trim()) throw new Error('写下一个场景或心情'); if (!Number.isInteger(amount) || amount < 1 || amount > 100) throw new Error('曲目数量请填写 1–100 的整数')
    fillDraft(`请从我的本地曲库挑选 ${amount} 首适合「${scene.trim()}」的音乐${style.trim() ? `，偏好风格：${style.trim()}` : ''}。兼顾曲目衔接，简要说明策展思路；实际曲目不足时说明数量，展示预览后让我确认创建歌单，不自动播放。`)
  }, 'arrow'))
}
function openShortcuts(): void {
  const { body } = sheet('快捷指令')
  for (const shortcut of data.promptLibrary.shortcuts) { const item = button('', 'shortcut-row', () => fillDraft(shortcut.text)); item.append(el('strong', '', shortcut.name), el('span', '', shortcut.text)); body.append(item) }
  body.append(button('管理快捷指令', 'btn full', () => openSettings('shortcuts'), 'edit'))
}
function openHistory(): void {
  const { body } = sheet('历史对话')
  void request<{ sessions: AppSnapshot['sessions'] }>({ type: 'session.list' }).then(result => {
    data.sessions = result.sessions; if (!result.sessions.length) body.append(el('p', 'muted', '还没有对话，从一个音乐任务开始。'))
    for (const item of result.sessions) {
      const row = el('div', 'history-row'), open = button('', 'history-open', () => loadSession(item.id)); open.append(el('strong', '', item.title), el('span', 'muted small', `${new Date(item.updatedAt).toLocaleDateString('zh-CN')}${isActive(store.runs.get(item.id)) ? ' · 进行中' : ''}`))
      const remove = iconButton('删除对话', 'trash', () => {
        const confirm = button('确认删除', 'btn danger small', async () => {
          const result = await request<{ sessions: AppSnapshot['sessions'] }>({ type: 'session.delete', id: item.id }); data.sessions = result.sessions; store.sessions.delete(item.id); store.runs.delete(item.id); sessionStorage.removeItem(draftKey(item.id))
          if (currentId === item.id) { currentId = ''; setDraft(readDraft()); schedule() }; openHistory()
        }); row.replaceChildren(el('span', 'muted small', '删除这段对话？'), confirm, button('取消', 'quiet-btn', openHistory))
      }); remove.disabled = isActive(store.runs.get(item.id)); row.append(open, remove); body.append(row)
    }
  }).catch(notice)
}
async function bootstrap(): Promise<void> {
  render()
  try {
    bridge = await createBridge()
    const stopAppearance = followAppearance(() => bridge.appearance(), () => notice('暂时无法读取应用主题色，重新打开面板可重试'), inputWrap)
    let libraryTimer: ReturnType<typeof setTimeout>
    bridge.onLibraryChange(() => {
      clearTimeout(libraryTimer)
      libraryTimer = setTimeout(() => { if (currentId) void request<Snapshot>({ type: 'session.load', id: currentId }).then(snapshot => { store.hydrate(snapshot); schedule() }).catch(notice) }, 200)
    })
    bridge.onPluginEvent(event => { store.event(event); schedule(); if (event.type === 'done') void refresh().catch(notice) })
    void bridge.environment().then(environment => { document.documentElement.dataset.reducedMotion = String(environment.reducedMotion) }).catch(() => { /* OS media preference remains active. */ })
    await refresh(); ready = true; setDraft(readDraft()); schedule()
    window.addEventListener('pagehide', () => { clearTimeout(libraryTimer); stopAppearance(); bridge.dispose() }, { once: true })
    document.addEventListener('visibilitychange', () => { if (!document.hidden) void (async () => { await refresh(); if (currentId) store.hydrate(await request<Snapshot>({ type: 'session.load', id: currentId })); schedule() })().catch(notice) })
  } catch (error) { notice(error); status.textContent = '未能连接宿主，请关闭助手后重试。'; live.hidden = false }
}
void bootstrap()
