import { el, button, iconButton, field, selectField, sheet, closeModal, formatTokens } from './dom'
import type { AppSnapshot, Profile, PromptLibrary, Session, Snapshot } from './types'
type Tab = 'api' | 'roles' | 'shortcuts'
export interface SettingsContext {
  data: () => AppSnapshot
  request: <T>(payload: unknown) => Promise<T>
  refresh: () => Promise<void>
  session: () => Session | undefined
  ensureSession: () => Promise<Session>
  schedule: () => void
  notice: (error: unknown) => void
}
export function settingsPanel(ctx: SettingsContext): (tab: Tab) => void {
  const { request, notice, schedule } = ctx
  const open = (tab: Tab) => {
    const { body, panel } = sheet('助手设置')
    const tabs = el('nav', 'settings-tabs'); tabs.setAttribute('aria-label', '设置分类')
    for (const [id, label] of [['api', 'AI 服务'], ['roles', '角色提示词'], ['shortcuts', '快捷指令']] as Array<[Tab, string]>) {
      const item = button(label, `tab${tab === id ? ' selected' : ''}`, () => open(id)); item.setAttribute('aria-current', tab === id ? 'page' : 'false'); tabs.append(item)
    }
    panel.insertBefore(tabs, body)
    if (tab === 'api') api(body); else if (tab === 'roles') roles(body); else shortcuts(body)
  }
  const api = (body: HTMLElement) => {
    const data = ctx.data()
    for (const profile of data.profiles) {
      const row = el('div', 'profile-row'), info = el('div', 'profile-info')
      info.append(el('strong', '', profile.label), el('span', 'muted small', `${profile.model}${profile.id === data.activeProfileId ? ' · 使用中' : ''}`))
      row.append(info, iconButton('编辑配置', 'edit', () => { body.textContent = ''; profileForm(body, { ...structuredClone(profile), apiKey: '' }) }))
      row.append(iconButton('删除配置', 'trash', () => {
        row.replaceChildren(el('span', 'muted small', `删除「${profile.label}」？`), button('删除', 'btn danger small', async () => { await request({ type: 'profile.delete', id: profile.id }); await ctx.refresh(); open('api') }), button('取消', 'quiet-btn', () => open('api')))
      })); body.append(row)
    }
    if (!data.profiles.length) { body.append(el('p', 'muted', '支持 OpenAI 兼容服务、Claude 和本地模型。')); profileForm(body, freshProfile()); return }
    body.append(button('新增 AI 配置', 'btn full', () => { body.textContent = ''; profileForm(body, freshProfile()) }, 'plus'))
    const usage = el('div', 'usage-line'); usage.append(el('span', 'muted small', `本月 ${data.usage.calls} 次调用 · ${formatTokens(data.usage.inputTokens + data.usage.outputTokens)} tokens`), el('span', 'muted small', `估算 ¥${data.usage.cost.toFixed(2)}`)); body.append(usage)
  }
  function freshProfile(): Profile { return { id: '', label: '', protocol: 'openai-chat', baseUrl: 'https://api.openai.com/v1', apiKey: '', model: '', vision: true, temperature: 0.6, pricing: { inputPerMillion: 0, outputPerMillion: 0 } } }
  function profileForm(body: HTMLElement, profile: Profile): void {
    const form = el('div', 'form-stack')
    const draw = () => {
      form.textContent = ''
      form.append(field('配置名称', profile.label, value => profile.label = value), selectField('接口协议', profile.protocol, [['openai-chat', 'OpenAI 兼容 / Chat Completions'], ['openai-responses', 'OpenAI Responses'], ['anthropic', 'Anthropic Claude']], value => { profile.protocol = value; profile.baseUrl = value === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1'; draw() }), field('API 地址', profile.baseUrl, value => profile.baseUrl = value, { hint: '兼容服务填到 /v1；本地服务可用 http://127.0.0.1:11434/v1' }), field('API Key', profile.apiKey, value => profile.apiKey = value, { type: 'password', hint: profile.id ? '留空保持原密钥' : '本地服务可留空，密钥仅保存到插件私有存储。' }))
      const modelField = field('模型名称', profile.model, value => profile.model = value)
      const modelInput = modelField.querySelector('input')!; modelInput.setAttribute('list', 'models-list')
      const list = el('datalist'); list.id = 'models-list'; modelField.append(list)
      const hint = el('span', 'field-hint')
      const fetchModels = button('获取模型', 'quiet-btn', async () => {
        fetchModels.disabled = true; fetchModels.textContent = '获取中…'; hint.textContent = ''; hint.classList.remove('danger')
        try {
          const result = await request<{ models: string[] }>({ type: 'models.list', protocol: profile.protocol, baseUrl: profile.baseUrl, apiKey: profile.apiKey, profileId: profile.id })
          list.replaceChildren(...result.models.map(model => { const option = el('option'); option.value = model; return option }))
          if (!profile.model) { profile.model = result.models[0] || ''; modelInput.value = profile.model }
          hint.textContent = `已获取 ${result.models.length} 个模型，也可手动输入。`
        } catch (error) { hint.textContent = (error as Error).message; hint.classList.add('danger') }
        finally { fetchModels.disabled = false; fetchModels.textContent = '获取模型' }
      })
      modelField.append(fetchModels, hint); form.append(modelField)
      form.append(selectField('视觉能力', String(profile.vision), [['true', '支持截图与封面'], ['false', '纯文本模型']], value => profile.vision = value === 'true'))
      const advanced = el('details', 'advanced'); advanced.append(el('summary', '', '温度与用量单价'))
      advanced.append(field('温度（0–2）', String(profile.temperature), value => profile.temperature = Number(value), { type: 'number' }), field('输入单价 / 百万 token', String(profile.pricing.inputPerMillion), value => profile.pricing.inputPerMillion = Number(value), { type: 'number' }), field('输出单价 / 百万 token', String(profile.pricing.outputPerMillion), value => profile.pricing.outputPerMillion = Number(value), { type: 'number' })); form.append(advanced)
      const save = button('保存配置', 'btn primary full', async () => {
        save.disabled = true
        try { await request({ type: 'profile.save', profile }); await ctx.refresh(); open('api') } finally { save.disabled = false }
      }); form.append(save)
    }
    draw(); body.append(form)
  }
  async function save(library: PromptLibrary): Promise<void> {
    const result = await request<{ promptLibrary: PromptLibrary }>({ type: 'prompts.save', library }); ctx.data().promptLibrary = result.promptLibrary; schedule()
  }
  function roles(body: HTMLElement): void {
    const library = structuredClone(ctx.data().promptLibrary)
    let selected = ctx.session()?.prompt.presetId || library.defaultPresetId
    if (!library.presets.some(item => item.id === selected)) selected = 'general'
    let editing = { ...library.presets.find(item => item.id === selected)! }
    if (ctx.session()?.prompt.presetId === selected) editing = { id: selected, name: ctx.session()!.prompt.name, systemPrompt: ctx.session()!.prompt.systemPrompt }
    const form = el('div', 'form-stack')
    const draw = () => {
      form.textContent = ''
      form.append(selectField('角色预设', selected, library.presets.map(item => [item.id, item.name]), id => { selected = id; editing = { ...library.presets.find(item => item.id === id)! }; draw() }), field('名称', editing.name, value => editing.name = value), field('系统提示词 · 角色正文', editing.systemPrompt, value => editing.systemPrompt = value, { multiline: true, hint: '应用后从下一轮生效，工具与修改确认机制保持不变。' }))
      const row = el('div', 'button-row wrap')
      row.append(button('保存预设', 'btn', async () => { Object.assign(library.presets.find(item => item.id === selected)!, editing); await save(library); notice('角色预设已保存'); draw() }), button('另存为', 'btn', async () => { editing = { ...editing, id: `role_${Date.now().toString(36)}`, name: `${editing.name} 副本` }; selected = editing.id; library.presets.push(editing); await save(library); draw() }))
      const builtin = ctx.data().promptDefaults.presets.find(item => item.id === selected)
      if (builtin) row.append(button('恢复内置', 'quiet-btn', async () => { editing = { ...builtin }; Object.assign(library.presets.find(item => item.id === selected)!, editing); await save(library); draw() }))
      else row.append(button('删除预设', 'quiet-btn danger', async () => { library.presets = library.presets.filter(item => item.id !== selected); if (library.defaultPresetId === selected) library.defaultPresetId = 'general'; await save(library); selected = 'general'; editing = { ...library.presets.find(item => item.id === selected)! }; draw() }))
      form.append(row, selectField('新对话默认角色', library.defaultPresetId, library.presets.map(item => [item.id, item.name]), id => { library.defaultPresetId = id; void save(library).catch(notice) }))
      form.append(button('应用到本会话', 'btn primary full', async () => { const target = await ctx.ensureSession(); const result = await request<Snapshot>({ type: 'session.prompt.set', sessionId: target.id, prompt: { presetId: selected, name: editing.name, systemPrompt: editing.systemPrompt } }); target.prompt = result.session.prompt; closeModal(); schedule() }, 'check'))
    }
    draw(); body.append(form)
  }
  function shortcuts(body: HTMLElement): void {
    const library = structuredClone(ctx.data().promptLibrary)
    const draw = () => {
      body.textContent = ''
      for (const item of library.shortcuts) {
        const row = el('div', 'shortcut-setting')
        row.append(field('名称', item.name, value => item.name = value), field('提示词', item.text, value => item.text = value, { multiline: true }), button('删除', 'quiet-btn danger', () => { library.shortcuts = library.shortcuts.filter(shortcut => shortcut.id !== item.id); draw() })); body.append(row)
      }
      const row = el('div', 'button-row wrap')
      row.append(button('新增指令', 'btn', () => { library.shortcuts.push({ id: `quick_${Date.now().toString(36)}`, name: '', text: '' }); draw(); body.querySelectorAll<HTMLInputElement>('input').item(library.shortcuts.length - 1)?.focus() }, 'plus'), button('恢复默认', 'quiet-btn', () => { library.shortcuts = structuredClone(ctx.data().promptDefaults.shortcuts); draw() }))
      body.append(row, button('保存快捷指令', 'btn primary full', async () => { await save(library); notice('快捷指令已保存'); open('shortcuts') }))
    }
    draw()
  }
  return open
}
