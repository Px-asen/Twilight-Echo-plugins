export const BUILTIN_PRESETS = [
  { id: 'general', name: '通用助手', systemPrompt: '用简洁、友好的中文帮助用户管理音乐与聆听体验。先回答当前问题，再给出必要的下一步。不要反复介绍自己的能力。' },
  { id: 'librarian', name: '曲库管家', systemPrompt: '你是一位细致的曲库管家。优先使用本地统计和已有曲目信息，区分事实、推断与缺失信息。整理流派、专辑和重复曲目时先展示范围与依据，不编造元数据；给出小批次、可核对的修改方案。' },
  { id: 'curator', name: '歌单策展', systemPrompt: '你是一位有品味的音乐策展人。根据场景、情绪、风格与曲目衔接，从用户真实的本地曲库选择音乐，简要说明选择理由。曲目不足时说明实际数量，不虚构曲库中不存在的歌曲。创建歌单前展示预览。' },
  { id: 'listening', name: '聆听顾问', systemPrompt: '你是一位清晰务实的聆听顾问。先读取当前播放与应用设置，再给出少量、有依据的声音或界面建议。解释调整的收益和取舍，避免无依据的音质承诺，不擅自提高音量。' }
]

export const BUILTIN_SHORTCUTS = [
  { id: 'similar', name: '相近的音乐', text: '根据当前播放的曲目，从我的本地曲库推荐风格相近的音乐，先列出推荐理由，不自动播放。' },
  { id: 'night', name: '深夜歌单', text: '从我的本地曲库挑选 20 首适合深夜安静聆听的音乐，注意风格衔接，展示歌单预览后让我确认创建。' },
  { id: 'metadata', name: '整理流派', text: '检查本地曲库的流派信息，找出缺失或命名不一致的部分，先给出有依据的整理方案，不编造缺失信息。' },
  { id: 'sound', name: '聆听建议', text: '先读取当前播放状态与应用设置，给出 3 项有依据的聆听优化建议；说明原因，修改前让我确认。' }
]

export function defaultPromptLibrary() {
  return structuredClone({ presets: BUILTIN_PRESETS, shortcuts: BUILTIN_SHORTCUTS, defaultPresetId: 'general' })
}

export function normalizePromptLibrary(value) {
  const defaults = defaultPromptLibrary()
  if (!value || typeof value !== 'object') return defaults
  const clean = (items, fields, maxText) => {
    if (!Array.isArray(items)) throw new Error('预设列表无效')
    const ids = new Set()
    return items.map(item => {
      const id = typeof item?.id === 'string' ? item.id.trim() : ''
      if (!/^[\w-]{1,80}$/.test(id) || ids.has(id)) throw new Error('预设标识无效或重复')
      ids.add(id)
      const result = { id }
      for (const field of fields) {
        const text = typeof item[field] === 'string' ? item[field].trim() : ''
        if (!text || text.length > (field === 'name' ? 60 : maxText)) throw new Error('请填写名称和提示词（名称最多 60 字，提示词最多 8000 字）')
        result[field] = text
      }
      return result
    })
  }
  const presets = clean(value.presets ?? defaults.presets, ['name', 'systemPrompt'], 8000)
  for (const preset of BUILTIN_PRESETS) {
    if (!presets.some(item => item.id === preset.id)) presets.push({ ...preset })
  }
  const shortcuts = clean(value.shortcuts ?? defaults.shortcuts, ['name', 'text'], 8000)
  const defaultPresetId = presets.some(item => item.id === value.defaultPresetId) ? value.defaultPresetId : 'general'
  return { presets, shortcuts, defaultPresetId }
}

export function promptSnapshot(library, id = library.defaultPresetId) {
  const preset = library.presets.find(item => item.id === id)
  if (!preset) throw new Error('角色预设不存在')
  return { presetId: preset.id, name: preset.name, systemPrompt: preset.systemPrompt }
}
