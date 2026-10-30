// Android entry: the desktop provider runs unchanged on the Android plugin
// runtime (sdk/android). Without the desktop's secure qishuiAuth helper it
// uses the official passport QR flow.
import { defineAndroidProvider } from '../../sdk/android/provider.js'
import * as plugin from './index.mjs'

defineAndroidProvider(plugin)
