// Android entry: the desktop provider runs unchanged on the Android plugin
// runtime (sdk/android). The embedded KuGouMusicApi service listens on the
// runtime's virtual loopback, and its stream proxy is resolved into the
// upstream CDN request, which the Android player opens itself.
//
// An external KuGouMusicApi address only exists on the desktop, so the
// settings form drops that field and always keeps the embedded service.
import { defineAndroidProvider } from '../../sdk/android/provider.js'
import * as plugin from './index.mjs'

const SETTINGS_COMMAND = 'kugou.settings'
const EMBEDDED_NOTICE = '服务已内置于插件，在应用的插件进程内运行，不会监听网络端口。'

function androidForm(form) {
  if (!form || typeof form !== 'object' || form.kind !== 'settings-form') return form
  return {
    ...form,
    notice: String(form.notice || '')
      .split('\n')
      .map((line) => (line.startsWith('服务已内置于插件') ? EMBEDDED_NOTICE : line))
      .join('\n'),
    fields: (form.fields || []).filter((field) => field.key !== 'apiBaseUrl')
  }
}

defineAndroidProvider(plugin, {
  commands: ({ registered }) => {
    const settings = registered(SETTINGS_COMMAND)
    if (!settings) return {}
    return {
      async [SETTINGS_COMMAND](values, ...rest) {
        const submitted = values && typeof values === 'object' && values.source !== 'settingsPanel'
        const result = await settings(submitted ? { ...values, apiBaseUrl: '' } : values, ...rest)
        if (result && typeof result === 'object' && result.form) return { ...result, form: androidForm(result.form) }
        return androidForm(result)
      }
    }
  }
})
