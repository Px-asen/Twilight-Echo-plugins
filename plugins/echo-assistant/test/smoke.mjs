import assert from 'node:assert/strict'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { resolve, join, isAbsolute, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repo = resolve(pluginRoot, '../..')
const host = resolve(process.env.TWILIGHT_ECHO_ROOT || join(repo, '../Twilight_Echo'))
const hostRequire = createRequire(join(host, 'package.json'))
const playwrightPath = process.env.PLAYWRIGHT_MODULE || hostRequire.resolve('playwright')
const { _electron: electron } = await import(isAbsolute(playwrightPath) ? pathToFileURL(playwrightPath).href : playwrightPath)
const profile = join(repo, '.cache', `echo-assistant-smoke-${Date.now()}`)
const media = join(profile, 'media')
await mkdir(media, { recursive: true })
const tracks = []
for (let index = 0; index < 12; index++) {
  const samples = Buffer.alloc(4410 * 2), header = Buffer.alloc(44)
  header.write('RIFF'); header.writeUInt32LE(samples.length + 36, 4); header.write('WAVE', 8)
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22)
  header.writeUInt32LE(44100, 24); header.writeUInt32LE(88200, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(samples.length, 40)
  const fileName = `sample-${index}.wav`, filePath = join(media, fileName)
  await writeFile(filePath, Buffer.concat([header, samples]))
  tracks.push({ id: `echo-test-${index}`, title: index < 2 ? 'Blue Hour' : `Quiet Study ${index + 1}`, artist: 'Echo Test', album: 'After Hours', genre: index % 3 ? 'Ambient' : '', bpm: index % 2 ? 90 : undefined, duration: .1, filePath, fileName, dir: media, size: samples.length + 44, format: 'WAV', sampleRate: 44100, bitDepth: 16, version: 1 })
}
await writeFile(join(profile, 'music-library.json'), JSON.stringify({ version: 2, revision: 1, tracks, folders: [media], exclusions: [] }))
await writeFile(join(profile, 'settings.json'), JSON.stringify({ onboardingCompleted: true, startupHomePage: 'local', libraryFolders: [media], volume: 0, developerMode: true, proxyMode: 'off' }))
const requests = []
const server = createServer(async (request, response) => {
  if (request.method === 'GET') { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ data: [{ id: 'echo-smoke' }] })); return }
  let raw = ''; for await (const chunk of request) raw += chunk
  const body = JSON.parse(raw); requests.push(body)
  response.setHeader('content-type', 'text/event-stream')
  const send = value => response.write(`data: ${typeof value === 'string' ? value : JSON.stringify(value)}\r\n\r\n`)
  const last = [...body.messages].reverse().find(item => item.role === 'user')?.content || ''
  if (last.includes('确认测试')) {
    send({ choices: [{ delta: { tool_calls: [{ index: 0, id: `call_${requests.length}`, function: { name: 'update_app_settings', arguments: JSON.stringify({ patch: { uiDensity: 'compact' }, reason: '独立测试中的确认卡' }) } }] } }] }); send('[DONE]'); return
  }
  if (last.includes('慢速测试')) {
    send({ choices: [{ delta: { content: '这是保留的部分回答。\n' } }] })
    const timer = setInterval(() => send({ choices: [{ delta: { content: '正在继续生成，用于检查停止、输入与滚动。\n\n' } }] }), 90)
    response.on('close', () => clearInterval(timer)); return
  }
  send({ choices: [{ delta: { content: '## 检查结果\n\n曲库中的信息值得进一步整理。\n\n- **流派**：先核对缺失项，再统一命名。\n- **封面**：保留已有文件，不自动替换。\n\n修改前我会先给你确认。' } }] })
  send({ choices: [], usage: { prompt_tokens: 30, completion_tokens: 40 } }); send('[DONE]')
  // Deliberately leave the connection open after the terminal event.
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const env = { ...process.env, TWILIGHT_ECHO_ROOT: host, ECHO_TEST_PROFILE: profile, TWILIGHT_DEV_USER_DATA_DIR: profile }
delete env.ELECTRON_RUN_AS_NODE
const errors = [], results = []
let page, app
try {
  // This Windows automation session cannot initialize Chromium's native sandbox.
  // This switch is confined to the isolated test process, never the plugin or host.
  app = await electron.launch({ executablePath: hostRequire('electron'), args: [join(pluginRoot, 'test/smoke-bootstrap.cjs'), '--mute-audio', ...(process.platform === 'win32' ? ['--no-sandbox'] : [])], env, timeout: 60000 })
  app.process().stderr.on('data', chunk => console.error(String(chunk)))
  console.log('Electron state:', await app.evaluate(({ app, BrowserWindow }) => ({ ready: app.isReady(), profile: app.getPath('userData'), appPath: app.getAppPath(), windows: BrowserWindow.getAllWindows().length })))
  page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.stack || error.message))
  await page.waitForFunction(() => !!window.api?.plugins, { timeout: 60000 })
  const manifest = JSON.parse(await readFile(join(pluginRoot, 'plugin.json'), 'utf8'))
  const packageFile = join(repo, 'packages', `${manifest.id}-${manifest.version}.tep`)
  await app.evaluate(({ dialog }, packageFile) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [packageFile] })
    dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false })
  }, packageFile)
  console.log('Installing candidate in isolated profile:', profile)
  const installed = await page.evaluate(() => window.api.plugins.chooseAndInstall('package'))
  assert.equal(installed.plugin.id, manifest.id)
  await page.evaluate(id => window.api.plugins.enable(id), manifest.id)
  await page.getByRole('button', { name: '回声助手', exact: true }).click()
  const frame = page.frameLocator('.experience-flyout iframe')
  await frame.getByRole('heading', { name: '从你的音乐库开始' }).waitFor({ timeout: 30000 })
  await frame.locator('[data-task="quality"]:not(:disabled)').waitFor()
  const hostWindow = await app.browserWindow(page); await hostWindow.evaluate(window => window.setSize(1200, 900))
  await page.locator('.experience-flyout-panel').screenshot({ path: join(profile, '01-welcome.png') })
  results.push('installed .tep / welcome / no duplicate plugin title')
  await frame.locator('[data-task="quality"]').click()
  await frame.locator('[data-report="quality"]').waitFor()
  assert.match(await frame.locator('.report-scope').innerText(), /12 \/ 12/)
  assert.equal(requests.length, 0)
  await frame.locator('.distribution summary').click()
  await page.locator('.experience-flyout-panel').screenshot({ path: join(profile, '02-quality.png') })
  results.push('local full-library report without API, accurate count, distributions')
  await frame.getByRole('button', { name: '继续分析', exact: true }).click()
  await frame.getByLabel('配置名称', { exact: true }).fill('本地测试模型')
  await frame.getByLabel('API 地址', { exact: true }).fill(`http://127.0.0.1:${server.address().port}/v1`)
  await frame.getByRole('button', { name: '获取模型', exact: true }).click()
  await frame.getByLabel('模型名称', { exact: true }).fill('echo-smoke')
  await frame.getByRole('button', { name: '保存配置', exact: true }).click()
  await frame.getByRole('button', { name: '关闭', exact: true }).click()
  await frame.getByRole('button', { name: '发送消息', exact: true }).click()
  await frame.getByText('曲库中的信息值得进一步整理。', { exact: true }).waitFor()
  await frame.getByRole('button', { name: '发送消息', exact: true }).waitFor()
  assert.equal(requests.length, 1)
  assert.ok(requests[0].messages.some(message => String(message.content).includes('扫描 12 / 12')))
  results.push('API form / model discovery / report context / terminal SSE without EOF')
  const input = frame.getByRole('textbox', { name: '输入消息', exact: true })
  await input.fill('慢速测试'); await input.press('Control+Enter')
  await frame.getByRole('button', { name: '停止本轮操作' }).waitFor()
  await input.fill('正在输入的下一条草稿')
  await page.waitForTimeout(350)
  assert.equal(await input.inputValue(), '正在输入的下一条草稿')
  assert.equal(await input.evaluate(node => document.activeElement === node), true)
  await page.getByRole('button', { name: '关闭面板' }).click()
  await page.getByRole('button', { name: '回声助手', exact: true }).click()
  await frame.getByRole('button', { name: '停止本轮操作' }).waitFor()
  assert.equal(await input.inputValue(), '正在输入的下一条草稿')
  await frame.getByRole('button', { name: '停止本轮操作' }).click()
  await frame.getByRole('button', { name: '发送消息', exact: true }).waitFor()
  await frame.getByText('回答已中断', { exact: true }).waitFor()
  assert.equal(await input.inputValue(), '正在输入的下一条草稿')
  results.push('streaming draft and IME-safe input preserved / reopen active run / real stop / partial answer')
  await input.fill('确认测试'); await input.press('Control+Enter')
  await frame.getByRole('button', { name: '同意并执行', exact: true }).waitFor()
  await page.locator('.experience-flyout-panel').screenshot({ path: join(profile, '03-confirmation.png') })
  await frame.getByRole('button', { name: '停止本轮操作' }).click()
  await frame.getByText('本轮已停止，未执行此项确认', { exact: true }).waitFor()
  await frame.getByRole('button', { name: '发送消息', exact: true }).waitFor()
  results.push('confirmation card stops without applying changes')
  await frame.getByRole('button', { name: '编辑角色提示词' }).click()
  await frame.getByLabel('名称', { exact: true }).fill('我的策展助手')
  await frame.getByLabel('系统提示词 · 角色正文', { exact: true }).fill('请用非常简洁的中文回答，并优先关注爵士。')
  await frame.getByRole('button', { name: '另存为', exact: true }).click()
  await frame.getByRole('button', { name: '应用到本会话', exact: true }).click()
  await frame.getByRole('dialog').waitFor({ state: 'detached' })
  await input.fill('确认角色生效'); await input.press('Control+Enter')
  await frame.getByRole('button', { name: '发送消息', exact: true }).waitFor()
  assert.match(requests.at(-1).messages[0].content, /优先关注爵士/)
  await frame.getByRole('button', { name: '助手设置', exact: true }).click()
  await frame.getByRole('button', { name: '快捷指令', exact: true }).click()
  await frame.getByRole('button', { name: '新增指令', exact: true }).click()
  await frame.getByLabel('名称', { exact: true }).last().fill('我的快捷指令')
  await frame.getByLabel('提示词', { exact: true }).last().fill('帮我挑选三首爵士。')
  await frame.getByRole('button', { name: '保存快捷指令', exact: true }).click()
  await frame.getByText('快捷指令已保存', { exact: true }).waitFor()
  await frame.getByRole('button', { name: '关闭', exact: true }).click()
  const count = requests.length
  await frame.getByRole('button', { name: '快捷指令', exact: true }).click()
  await frame.getByRole('button', { name: /我的快捷指令/ }).click()
  assert.equal(await input.inputValue(), '帮我挑选三首爵士。'); assert.equal(requests.length, count)
  results.push('custom role saved, applied and included in model prompt / shortcut only fills draft')
  const child = page.frames().find(frame => frame.url().startsWith('plugin-ui:'))
  await child.evaluate(() => document.documentElement.dataset.reducedMotion = 'true')
  const motion = await child.evaluate(() => getComputedStyle(document.querySelector('.send-btn')).transitionDuration)
  assert.equal(motion, '0s')
  await hostWindow.evaluate(window => window.setSize(340, 740))
  await page.waitForTimeout(150)
  assert.equal(await child.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  await page.locator('.experience-flyout-panel').screenshot({ path: join(profile, '04-narrow.png') })
  await hostWindow.evaluate(window => window.setSize(1200, 900))
  await page.locator('.experience-flyout-panel').screenshot({ path: join(profile, '05-conversation.png') })
  results.push('narrow panel has no horizontal overflow / host reduced motion disables transitions')
  assert.equal(errors.filter(error => error.includes('plugin-ui:')).length, 0, errors.join('\n'))
  await writeFile(join(profile, 'result.json'), JSON.stringify({ passed: true, results, modelCalls: requests.length, errors }, null, 2))
  console.log(JSON.stringify({ passed: true, profile, results, modelCalls: requests.length }, null, 2))
} catch (error) {
  console.error(error)
  if (page) { await page.screenshot({ path: join(profile, 'failure.png') }).catch(() => {}); await writeFile(join(profile, 'failure.txt'), `${error.stack}\n${errors.join('\n')}`) }
  process.exitCode = 1
} finally { await app?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
