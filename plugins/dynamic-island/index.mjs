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
const UNSUPPORTED_MESSAGE =
  '当前 Twilight Echo 版本不包含灵动岛 Overlay API，灵动岛不会显示。请升级到包含该功能的构建后再试。'

let pluginContext = null
let overlayApi = null
let config = null
let visible = false
let configQueue = Promise.resolve()

function requireContext() {
  if (!pluginContext) throw new Error('灵动岛插件未激活')
  return pluginContext
}

// Twilight Echo 1.2.3 预览版才引入宿主 Overlay API，旧版本没有
// `twilight.overlay`。这里做能力探测，避免在旧版本上激活失败。
function resolveOverlay(context) {
  const overlay = context?.twilight?.overlay
  if (
    !overlay ||
    typeof overlay.configure !== 'function' ||
    typeof overlay.show !== 'function' ||
    typeof overlay.hide !== 'function'
  ) {
    return null
  }
  return overlay
}

function requireOverlay() {
  if (!overlayApi) throw new Error(UNSUPPORTED_MESSAGE)
  return overlayApi
}

function enqueue(task) {
  const run = configQueue.then(task, task)
  configQueue = run.catch(() => undefined)
  return run
}

async function applyConfig(input) {
  const context = requireContext()
  const resolved = await requireOverlay().configure(input)
  config = resolved
  await context.settings.set(CONFIG_KEY, resolved)
  return resolved
}

async function setVisible(next) {
  const context = requireContext()
  const overlay = requireOverlay()
  if (next) await overlay.show()
  else await overlay.hide()
  visible = next
  await context.settings.set(VISIBLE_KEY, next)
}

async function registerContributions(supported) {
  const context = requireContext()
  await context.twilight.ui.register({
    id: 'dynamic-island-toggle',
    kind: 'playerBarButton',
    title: supported ? '灵动岛' : '灵动岛（当前版本不支持）',
    description: supported ? '显示或隐藏顶部灵动岛播放器' : UNSUPPORTED_MESSAGE,
    icon: 'pi pi-expand',
    command: TOGGLE_COMMAND
  })

  await context.twilight.ui.register({
    id: 'dynamic-island-diy',
    kind: 'settingsPanel',
    title: supported ? '灵动岛 DIY' : '灵动岛 DIY（当前版本不支持）',
    // 设置页会直接展示 title/description，因此缺少 Overlay API 时
    // 用户未点击也能看到「灵动岛不会显示」的提示。
    description: supported
      ? '自定义灵动岛的外观、尺寸、显示内容与交互方式'
      : UNSUPPORTED_MESSAGE,
    icon: 'pi pi-palette',
    command: OPEN_SETTINGS_COMMAND,
    settingsSection: 'appearance',
    autoLoad: true
  })
}

function registerUnsupportedHandlers() {
  const context = requireContext()
  for (const command of [
    TOGGLE_COMMAND,
    OPEN_SETTINGS_COMMAND,
    SAVE_SETTINGS_COMMAND,
    RESET_SETTINGS_COMMAND
  ]) {
    context.twilight.ui.onCommand(command, async () => UNSUPPORTED_MESSAGE)
  }
  // 写入插件日志，方便排查为什么灵动岛没有出现。
  context.logger?.warn?.(UNSUPPORTED_MESSAGE)
  // 新宿主提供 ui.notify 时会弹出提示；旧宿主没有该方法则静默跳过。
  const notify = context.twilight.ui?.notify
  if (typeof notify === 'function') {
    Promise.resolve(
      notify({ kind: 'warning', message: UNSUPPORTED_MESSAGE, durationMs: 8000 })
    ).catch(() => undefined)
  }
}

export async function activate(context) {
  pluginContext = context
  overlayApi = resolveOverlay(context)

  // 旧版本没有 Overlay API：仍然注册入口，方便用户看到清晰的提示，
  // 而不是让插件激活失败。
  if (!overlayApi) {
    registerUnsupportedHandlers()
    await registerContributions(false)
    return
  }

  const stored = await context.settings.get(CONFIG_KEY).catch(() => undefined)
  config = await applyConfig(stored ?? {})
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

  await registerContributions(true)

  if (visible) await overlayApi.show()
}

export async function deactivate() {
  if (!pluginContext) return
  if (overlayApi) await overlayApi.hide().catch(() => undefined)
  pluginContext = null
  overlayApi = null
  config = null
  visible = false
  configQueue = Promise.resolve()
}
