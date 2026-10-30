// Android entry: the desktop provider runs unchanged on the Android plugin
// runtime (sdk/android). Its loopback stream proxy is resolved into the
// upstream CDN request, which the Android player opens itself.
import { defineAndroidProvider } from '../../sdk/android/provider.js'
import * as plugin from './index.mjs'

defineAndroidProvider(plugin)
