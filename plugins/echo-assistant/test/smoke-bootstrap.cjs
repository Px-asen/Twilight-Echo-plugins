const { app, BrowserWindow, dialog } = require('electron')
const { resolve, join } = require('node:path')
const { mkdirSync, appendFileSync } = require('node:fs')
if (!process.env.ECHO_TEST_PROFILE || !process.env.TWILIGHT_ECHO_ROOT) throw new Error('An isolated ECHO_TEST_PROFILE and TWILIGHT_ECHO_ROOT are required')
app.setPath('userData', resolve(process.env.ECHO_TEST_PROFILE))
app.setAppPath(resolve(process.env.TWILIGHT_ECHO_ROOT))
const logs = join(process.env.ECHO_TEST_PROFILE, 'logs')
mkdirSync(logs, { recursive: true }); app.setPath('logs', logs)
process.env.TWILIGHT_LOG_DIRECTORY = join(logs, 'diagnostics')
const capture = message => appendFileSync(join(logs, 'bootstrap.txt'), `${message}\n`)
process.on('uncaughtExceptionMonitor', error => capture(error.stack || String(error)))
process.on('unhandledRejection', error => capture(error?.stack || String(error)))
dialog.showErrorBox = (title, content) => { capture(`${title}\n${content}`); app.exit(1) }
app.commandLine.appendSwitch('disable-background-timer-throttling')
app.commandLine.appendSwitch('disable-renderer-backgrounding')
BrowserWindow.prototype.show = function () {}
app.on('browser-window-created', (_event, window) => window.webContents.setBackgroundThrottling(false))
try {
  require(join(process.env.TWILIGHT_ECHO_ROOT, 'out/main/index.js'))
} catch (error) {
  require('node:fs').writeFileSync(join(process.env.ECHO_TEST_PROFILE, 'bootstrap-error.txt'), error.stack || String(error))
  app.exit(1)
}
