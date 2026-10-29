/**
 * Host-rendered settings form (API v1-3 settingsPanel). It edits the active
 * profile quickly; full multi-profile management lives in the chat panel.
 */
import { PROTOCOLS } from './providers.mjs'

export const SETTINGS_COMMAND = 'echo-assistant.settings'
export const SETTINGS_SAVE_COMMAND = 'echo-assistant.settings.save'

const PROTOCOL_LABELS = {
  'openai-chat': 'OpenAI 兼容 / Chat Completions',
  'openai-responses': 'OpenAI Responses',
  anthropic: 'Anthropic Claude'
}

function select(...options) {
  return { type: 'select', options: options.map(([value, label]) => ({ value, label })) }
}

export function buildConfigForm(config) {
  const profiles = config.profiles ?? []
  const active = profiles.find((profile) => profile.id === config.activeProfileId) ?? profiles[0]
  return {
    kind: 'settings-form',
    submitCommand: SETTINGS_SAVE_COMMAND,
    live: false,
    notice: profiles.length
      ? '这里编辑当前启用的 API 配置。完整的配置管理（新增/删除/多套切换）在侧边栏「回声助手」聊天页里。'
      : '尚未配置 API。可以先在这里填一套，之后在侧边栏「回声助手」里可管理多套配置。',
    fields: [
      ...(profiles.length
        ? [
            {
              key: 'activeProfileId',
              label: '当前配置',
              group: 'API 配置',
              type: 'select',
              value: active.id,
              options: profiles.map((profile) => ({ value: profile.id, label: profile.label }))
            }
          ]
        : []),
      {
        key: 'label',
        label: '配置名称',
        group: 'API 配置',
        type: 'text',
        value: active?.label ?? ''
      },
      {
        key: 'protocol',
        label: '接口协议',
        group: 'API 配置',
        type: 'select',
        value: active?.protocol ?? 'openai-chat',
        options: PROTOCOLS.map((protocol) => ({
          value: protocol,
          label: PROTOCOL_LABELS[protocol]
        }))
      },
      {
        key: 'baseUrl',
        label: 'API 地址',
        group: 'API 配置',
        description: 'OpenAI 兼容服务填到 /v1，例如 https://api.deepseek.com/v1；Claude 官方填 https://api.anthropic.com',
        type: 'text',
        value: active?.baseUrl ?? 'https://api.openai.com/v1'
      },
      {
        key: 'apiKey',
        label: 'API Key',
        group: 'API 配置',
        description: '留空且地址是本机服务时不校验；保存后不再回显明文',
        type: 'password',
        value: ''
      },
      {
        key: 'model',
        label: '模型名称',
        group: 'API 配置',
        description: '例如 gpt-4o、claude-sonnet-4-20250514、deepseek-chat',
        type: 'text',
        value: active?.model ?? ''
      },
      {
        key: 'vision',
        label: '支持视觉（看截图/封面）',
        group: '模型能力',
        type: 'toggle',
        value: String(active?.vision !== false)
      },
      {
        key: 'temperature',
        label: '创造性',
        group: '模型能力',
        type: 'range',
        min: 0,
        max: 2,
        step: 0.1,
        value: String(active?.temperature ?? 0.6)
      },
      {
        key: 'inputPerMillion',
        label: '输入单价（每百万 token）',
        group: '用量计费（可选）',
        type: 'text',
        value: String(active?.pricing?.inputPerMillion ?? 0)
      },
      {
        key: 'outputPerMillion',
        label: '输出单价（每百万 token）',
        group: '用量计费（可选）',
        type: 'text',
        value: String(active?.pricing?.outputPerMillion ?? 0)
      }
    ]
  }
}

/** Applies the flat form values back onto the config object. */
export function applyConfigFormValues(config, values) {
  const record = values && typeof values === 'object' && !Array.isArray(values) ? values : {}
  const profiles = [...(config.profiles ?? [])]
  let activeProfileId =
    typeof record.activeProfileId === 'string' && profiles.some((p) => p.id === record.activeProfileId)
      ? record.activeProfileId
      : config.activeProfileId
  const index = Math.max(
    0,
    profiles.findIndex((profile) => profile.id === activeProfileId)
  )
  const current = profiles[index] ?? { id: `p_${Date.now().toString(36)}` }
  const apiKey = typeof record.apiKey === 'string' && record.apiKey.trim() ? record.apiKey.trim() : current.apiKey ?? ''
  const updated = {
    ...current,
    label: text(record.label) || text(record.model) || current.label || '默认配置',
    protocol: PROTOCOLS.includes(record.protocol) ? record.protocol : current.protocol ?? 'openai-chat',
    baseUrl: text(record.baseUrl) || current.baseUrl,
    apiKey,
    model: text(record.model) || current.model,
    vision: record.vision === undefined ? current.vision !== false : record.vision === 'true' || record.vision === true,
    temperature: number(record.temperature, current.temperature ?? 0.6, 0, 2),
    pricing: {
      inputPerMillion: number(record.inputPerMillion, current.pricing?.inputPerMillion ?? 0, 0, 10000),
      outputPerMillion: number(record.outputPerMillion, current.pricing?.outputPerMillion ?? 0, 0, 10000)
    }
  }
  profiles[index] = updated
  activeProfileId = updated.id
  return { profiles, activeProfileId }
}

function text(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function number(value, fallback, min, max) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}
