// Android entry: the desktop provider runs unchanged on the Android plugin
// runtime (sdk/android). The server address is granted by the Android login
// form (androidRuntime.userServer), never by the plugin.
import { defineAndroidProvider } from '../../sdk/android/provider.js'
import * as plugin from './index.mjs'

defineAndroidProvider(plugin)
