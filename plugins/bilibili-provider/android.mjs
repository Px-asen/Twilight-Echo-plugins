// Android entry: the desktop provider runs unchanged on the Android plugin
// runtime (sdk/android). Its loopback stream/image proxy is resolved into the
// upstream CDN request, which the Android player opens itself.
import { defineAndroidProvider } from '../../sdk/android/provider.js'
import * as plugin from './index.mjs'

// The desktop "Bilibili 账号" panel only toggles pinned favorite folders and
// renders no form; invoked without a folder it clears every pin.
defineAndroidProvider(plugin, { panels: () => [] })
