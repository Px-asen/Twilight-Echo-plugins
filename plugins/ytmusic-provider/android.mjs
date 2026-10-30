// Android entry: the desktop provider runs unchanged on the Android plugin
// runtime (sdk/android). Its loopback stream proxy is resolved into the
// upstream googlevideo request, which the Android player opens itself.
//
// The desktop cookie import is an HTML page served by the plugin; Android
// shows a native settings form instead and submits it to the same handler.
import { defineAndroidProvider } from '../../sdk/android/provider.js'
import * as plugin from './index.mjs'

const ACCOUNT_PAGE_COMMAND = 'ytmusic.accountSettings'
const ACCOUNT_FORM_COMMAND = 'ytmusic.android.account'

function decodeEntities(text) {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}

function pageText(html, pattern) {
  const match = pattern.exec(html)
  return match ? decodeEntities(match[1].trim()) : ''
}

defineAndroidProvider(plugin, {
  commands: ({ runCommand }) => {
    async function accountForm(values) {
      const page = String(await runCommand(ACCOUNT_PAGE_COMMAND))
      const status = [
        pageText(page, /<p class="status">([^<]*)<\/p>/),
        ...[...page.matchAll(/<p class="muted">((?:OAuth|高级 OAuth client)[^<]*)<\/p>/g)].map((match) => decodeEntities(match[1].trim()))
      ].filter(Boolean)
      const form = {
        kind: 'settings-form',
        submitCommand: ACCOUNT_FORM_COMMAND,
        notice: [
          ...status,
          '在浏览器登录 music.youtube.com 后，粘贴原始 Cookie 或完整请求头；必须包含 SAPISID 或 __Secure-3PAPISID。'
        ].join('\n'),
        fields: [
          { key: 'cookie', label: 'Cookie 或完整请求头', type: 'password', placeholder: 'Cookie: SID=...; __Secure-3PAPISID=...' },
          { key: 'oauth_client_id', label: '高级 OAuth client_id（可选）', type: 'text', group: '高级 OAuth client' },
          { key: 'oauth_client_secret', label: '高级 OAuth client_secret（可选）', type: 'password', group: '高级 OAuth client' }
        ]
      }
      if (!values || typeof values !== 'object' || values.source === 'settingsPanel') return form
      const action = pageText(page, /<form method="post" action="([^"]+)"/)
      if (!action) throw new Error('YouTube Music 账号设置不可用')
      const body = new URLSearchParams()
      for (const key of ['cookie', 'oauth_client_id', 'oauth_client_secret']) {
        body.set(key, typeof values[key] === 'string' ? values[key] : '')
      }
      const response = await fetch(action, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString()
      })
      const message = pageText(await response.text(), /<p>([^<]*)<\/p>/) || `HTTP ${response.status}`
      if (!response.ok) throw new Error(message)
      return { message, form: await accountForm({ source: 'settingsPanel' }) }
    }
    return { [ACCOUNT_FORM_COMMAND]: accountForm }
  },
  panels: (panels) => [
    ...panels,
    {
      id: 'ytmusic-android-account',
      title: 'YouTube Music Cookie',
      description: '导入浏览器 Cookie 以启用私人音乐库',
      command: ACCOUNT_FORM_COMMAND
    }
  ]
})
