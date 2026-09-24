export const SAVE_SETTINGS_COMMAND = 'dynamic-island.settings.save'
export const RESET_SETTINGS_COMMAND = 'dynamic-island.settings.reset'

const GROUP_TITLES = {
  appearance: '外观',
  layout: '布局与尺寸',
  components: '显示的组件',
  behavior: '交互行为'
}

function range(min, max, unit, step) {
  return { type: 'range', min, max, unit, ...(step ? { step } : {}) }
}

function select(...options) {
  return { type: 'select', options: options.map(([value, label]) => ({ value, label })) }
}

const TOGGLE = { type: 'toggle' }
const COLOR = { type: 'color' }

// Bounds mirror the host's DYNAMIC_ISLAND_LIMITS; the host remains authoritative.
export const DIY_FIELDS = [
  { section: 'appearance', name: 'backgroundColor', label: '背景颜色', spec: COLOR },
  {
    section: 'appearance',
    name: 'backgroundOpacity',
    label: '背景不透明度',
    spec: range(30, 100, '%')
  },
  { section: 'appearance', name: 'textColor', label: '文字颜色', spec: COLOR },
  {
    section: 'appearance',
    name: 'accentSource',
    label: '强调色来源',
    spec: select(['custom', '自定义颜色'], ['cover', '跟随封面主色'])
  },
  {
    section: 'appearance',
    name: 'accentColor',
    label: '强调色',
    description: '用于收藏、音量与频谱发光；跟随封面时作为无歌曲时的备用色',
    spec: COLOR
  },
  { section: 'appearance', name: 'visualizerColor', label: '频谱颜色', spec: COLOR },
  { section: 'appearance', name: 'fontScale', label: '文字大小', spec: range(80, 130, '%') },
  {
    section: 'appearance',
    name: 'collapsedRadius',
    label: '收起圆角',
    description: '不超过收起高度的一半',
    spec: range(0, 32, 'px')
  },
  { section: 'appearance', name: 'expandedRadius', label: '展开圆角', spec: range(16, 72, 'px') },
  {
    section: 'appearance',
    name: 'audioReactive',
    label: '封面随音乐律动',
    description: '封面根据实时音量轻微缩放与发光',
    spec: TOGGLE
  },
  {
    section: 'layout',
    name: 'collapsedWidth',
    label: '收起宽度',
    spec: range(160, 360, 'px', 2)
  },
  { section: 'layout', name: 'collapsedHeight', label: '收起高度', spec: range(36, 64, 'px') },
  {
    section: 'layout',
    name: 'expandedWidth',
    label: '展开宽度',
    description: '展开高度按宽度与显示的组件自动计算，内容等比缩放',
    spec: range(360, 560, 'px', 2)
  },
  {
    section: 'layout',
    name: 'anchor',
    label: '水平位置',
    spec: select(['left', '靠左'], ['center', '居中'], ['right', '靠右'])
  },
  { section: 'layout', name: 'offsetX', label: '水平偏移', spec: range(-600, 600, 'px') },
  { section: 'layout', name: 'offsetY', label: '距屏幕顶部', spec: range(0, 200, 'px') },
  {
    section: 'layout',
    name: 'display',
    label: '显示屏幕',
    spec: select(['main-window', '跟随主窗口所在屏幕'], ['primary', '主显示器'])
  },
  {
    section: 'components',
    name: 'collapsedContent',
    label: '收起时显示',
    spec: select(['artwork', '封面与频谱'], ['track', '歌名与歌手'], ['lyric', '当前歌词'])
  },
  { section: 'components', name: 'cover', label: '封面', spec: TOGGLE },
  {
    section: 'components',
    name: 'visualizer',
    label: '频谱',
    description: '关闭后停止采样音频数据，更省资源',
    spec: TOGGLE
  },
  { section: 'components', name: 'lyric', label: '展开时显示歌词', spec: TOGGLE },
  { section: 'components', name: 'progress', label: '进度条', spec: TOGGLE },
  {
    section: 'components',
    name: 'time',
    label: '播放时间',
    description: '需同时开启进度条',
    spec: TOGGLE
  },
  { section: 'components', name: 'favorite', label: '收藏按钮', spec: TOGGLE },
  { section: 'components', name: 'skip', label: '上一首 / 下一首', spec: TOGGLE },
  { section: 'components', name: 'volume', label: '音量按钮', spec: TOGGLE },
  {
    section: 'behavior',
    name: 'expandTrigger',
    label: '展开方式',
    spec: select(['hover', '鼠标悬停展开'], ['click', '点击展开'])
  },
  {
    section: 'behavior',
    name: 'collapseDelayMs',
    label: '收起延迟',
    description: '鼠标离开后等待多久再收起',
    spec: range(0, 3000, 'ms', 50)
  },
  {
    section: 'behavior',
    name: 'motion',
    label: '动画速度',
    spec: select(['off', '关闭'], ['fast', '快'], ['normal', '标准'], ['slow', '慢'])
  },
  {
    section: 'behavior',
    name: 'visibility',
    label: '自动隐藏',
    spec: select(
      ['always', '始终显示'],
      ['when-track', '有歌曲时显示'],
      ['when-playing', '仅播放时显示']
    )
  }
]

function fieldKey(field) {
  return `${field.section}.${field.name}`
}

function currentValue(config, field) {
  return config[field.section][field.name]
}

function toFormField(config, field) {
  const base = {
    key: fieldKey(field),
    label: field.label,
    group: GROUP_TITLES[field.section],
    value: String(currentValue(config, field)),
    ...(field.description ? { description: field.description } : {})
  }
  return { ...base, ...field.spec }
}

export function buildDiyForm(config) {
  return {
    kind: 'settings-form',
    submitCommand: SAVE_SETTINGS_COMMAND,
    resetCommand: RESET_SETTINGS_COMMAND,
    live: true,
    notice: '修改会实时应用到屏幕顶部的灵动岛。',
    fields: DIY_FIELDS.map((field) => toFormField(config, field))
  }
}

export function parseDiyValues(current, values) {
  const record = values && typeof values === 'object' && !Array.isArray(values) ? values : {}
  const next = {
    appearance: { ...current.appearance },
    layout: { ...current.layout },
    components: { ...current.components },
    behavior: { ...current.behavior }
  }
  for (const field of DIY_FIELDS) {
    const raw = record[fieldKey(field)]
    if (typeof raw !== 'string') continue
    switch (field.spec.type) {
      case 'toggle':
        next[field.section][field.name] = raw === 'true'
        break
      case 'range': {
        const value = Number(raw)
        if (raw.trim() !== '' && Number.isFinite(value)) next[field.section][field.name] = value
        break
      }
      default:
        next[field.section][field.name] = raw
    }
  }
  return next
}
