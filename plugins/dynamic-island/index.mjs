import {
  RESET_SETTINGS_COMMAND,
  SAVE_SETTINGS_COMMAND,
  buildDiyForm,
  parseDiyValues
} from './config.mjs'

const TOGGLE_COMMAND = 'dynamic-island.toggle'
const OPEN_SETTINGS_COMMAND = 'dynamic-island.settings.open'
const CONFIG_KEY = 'config'
const VISIBLE_KEY = 'visible'

let pluginContext = null
let config = null
let visible = false
let configQueue = Promise.resolve()

function requireContext() {
  if (!pluginContext) throw new Error('灵动岛插件未激活')
  return pluginContext
}

function enqueue(task) {
  const run = configQueue.then(task, task)
  configQueue = run.catch(() => undefined)
  return run
}

async function applyConfig(input) {
  const context = requireContext()
  const resolved = await context.twilight.overlay.configure(input)
  config = resolved
  await context.settings.set(CONFIG_KEY, resolved)
  return resolved
}

async function setVisible(next) {
  const context = requireContext()
  if (next) await context.twilight.overlay.show()
  else await context.twilight.overlay.hide()
  visible = next
  await context.settings.set(VISIBLE_KEY, next)
}

export async function activate(context) {
  pluginContext = context
  const stored = await context.settings.get(CONFIG_KEY).catch(() => undefined)
  config = await context.twilight.overlay.configure(stored ?? {})
  visible = (await context.settings.get(VISIBLE_KEY).catch(() => undefined)) !== false

  context.twilight.ui.onCommand(TOGGLE_COMMAND, async () => {
    await setVisible(!visible)
    return visible ? '灵动岛已显示' : '灵动岛已隐藏'
  })

  context.twilight.ui.onCommand(OPEN_SETTINGS_COMMAND, async () => {
    return buildDiyForm(config ?? (await applyConfig({})))
  })

  context.twilight.ui.onCommand(SAVE_SETTINGS_COMMAND, (...args) =>
    enqueue(async () => {
      const current = config ?? (await applyConfig({}))
      const resolved = await applyConfig(parseDiyValues(current, args[0]))
      return { message: '已保存并应用', form: buildDiyForm(resolved) }
    })
  )

  context.twilight.ui.onCommand(RESET_SETTINGS_COMMAND, () =>
    enqueue(async () => {
      const resolved = await applyConfig({})
      return { message: '已恢复默认外观', form: buildDiyForm(resolved) }
    })
  )

  await context.twilight.ui.register({
    id: 'dynamic-island-toggle',
    kind: 'playerBarButton',
    title: '灵动岛',
    description: '显示或隐藏顶部灵动岛播放器',
    icon: 'pi pi-expand',
    command: TOGGLE_COMMAND
  })

  await context.twilight.ui.register({
    id: 'dynamic-island-diy',
    kind: 'settingsPanel',
    title: '灵动岛 DIY',
    description: '自定义灵动岛的外观、尺寸、显示内容与交互方式',
    icon: 'pi pi-palette',
    command: OPEN_SETTINGS_COMMAND,
    autoLoad: true
  })

  if (visible) await context.twilight.overlay.show()
}

export async function deactivate() {
  if (!pluginContext) return
  await pluginContext.twilight.overlay.hide().catch(() => undefined)
  pluginContext = null
  config = null
  visible = false
  configQueue = Promise.resolve()
}
