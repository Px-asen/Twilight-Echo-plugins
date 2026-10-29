import assert from 'node:assert/strict'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { resolve, join, isAbsolute, dirname, extname, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createGateway } from '../gateway.mjs'

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repo = resolve(pluginRoot, '../..')
const require = createRequire(import.meta.url)
const modulePath = process.env.PLAYWRIGHT_MODULE || require.resolve('playwright')
const { chromium } = await import(isAbsolute(modulePath) ? pathToFileURL(modulePath).href : modulePath)
const profile = join(repo, '.cache', `echo-assistant-ui-${Date.now()}`)
await mkdir(profile, { recursive: true })
const modelCalls = [], errors = [], results = []
const fixture = {
  revision: 1, delay: 35, writes: 0, reducedMotion: false, settings: { uiDensity: 'comfortable', theme: 'dark', lightAccentColor: 'blue', darkAccentColor: 'blue', motionPreference: 'full' },
  tracks: Array.from({ length: 421 }, (_, i) => ({ id: `t${i}`, version: 1, title: i < 2 ? 'Blue Hour' : `Quiet Study ${String(i).padStart(3, '0')}`, artist: 'Echo Test', album: i === 1 ? 'Live Sessions' : 'After Hours', format: i === 1 ? 'MP3' : 'FLAC', duration: 180, sampleRate: i === 1 ? 44100 : 96000, bitDepth: i === 1 ? undefined : 24, genre: i % 3 ? 'Ambient' : '', bpm: i % 2 ? 90 : undefined }))
}
const settings = new Map()
let page, browser, gateway
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://localhost')
    if (url.pathname === '/v1/models') { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ data: [{ id: 'echo-smoke' }] })); return }
    if (url.pathname === '/v1/chat/completions') {
      let raw = ''; for await (const chunk of request) raw += chunk
      const body = JSON.parse(raw); modelCalls.push(body)
      response.setHeader('content-type', 'text/event-stream')
      const send = value => response.write(`data: ${typeof value === 'string' ? value : JSON.stringify(value)}\r\n\r\n`)
      const last = [...body.messages].reverse().find(item => item.role === 'user')?.content || ''
      if (last.includes('确认测试') && body.messages.at(-1).role !== 'tool') {
        send({ choices: [{ delta: { tool_calls: [{ index: 0, id: `call_${modelCalls.length}`, function: { name: 'update_app_settings', arguments: JSON.stringify({ patch: { uiDensity: 'compact' }, reason: '仅修改独立测试数据' }) } }] } }] }); send('[DONE]'); return
      }
      if (last.includes('慢速测试')) {
        send({ choices: [{ delta: { content: '这是保留的部分回答。\n\n' } }] })
        const timer = setInterval(() => send({ choices: [{ delta: { content: '正在继续生成，用于检查停止、输入与滚动。\n\n' } }] }), 25)
        response.on('close', () => clearInterval(timer)); return
      }
      send({ choices: [{ delta: { content: '## 检查结果\n\n曲库中的信息值得进一步整理。\n\n- **流派**：先核对缺失项，再统一命名。\n- **封面**：保留已有文件，不自动替换。\n\n修改前我会先给你确认。' } }] })
      send({ choices: [], usage: { prompt_tokens: 30, completion_tokens: 40 } }); send('[DONE]')
      return // Terminal protocol event deliberately precedes connection close.
    }
    if (url.pathname === '/') { response.setHeader('content-type', 'text/html; charset=utf-8'); response.end(hostHtml); return }
    const resource = decodeURIComponent(url.pathname).replace(/^\/ui\//, '')
    const file = resolve(pluginRoot, 'ui-dist', resource)
    if (!url.pathname.startsWith('/ui/') || relative(join(pluginRoot, 'ui-dist'), file).startsWith('..')) { response.writeHead(404).end(); return }
    response.setHeader('content-type', ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' })[extname(file)] || 'application/octet-stream')
    response.end(await readFile(file))
  } catch (error) { response.writeHead(500).end(String(error)) }
})
const hostHtml = `<!doctype html><meta charset="utf-8"><style>
:root{color-scheme:dark;--host-bg:#101010;--host-surface:#1e1e1e;--host-text:#eeeeee;--host-line:#343434}:root[data-tone=light]{color-scheme:light;--host-bg:#efefef;--host-surface:#fafafa;--host-text:#222222;--host-line:#dddddd}*{box-sizing:border-box}body{margin:0;background:var(--host-bg);color:var(--host-text);font:14px 'Segoe UI','Microsoft YaHei',sans-serif}.test-label{position:fixed;left:24px;top:24px;color:#888888}.panel{position:fixed;inset:16px 16px 16px auto;width:420px;max-width:calc(100vw - 24px);display:flex;flex-direction:column;border:1px solid var(--host-line);border-radius:14px;overflow:hidden;box-shadow:0 16px 80px #0003}header{height:48px;flex-shrink:0;display:flex;align-items:center;justify-content:space-between;padding:0 17px;background:var(--host-surface);color:var(--host-text);font-weight:600}header button{border:0;background:transparent;color:inherit;font-size:20px;cursor:pointer}iframe{width:100%;flex:1;border:0;background:transparent;min-height:0}#open{margin:60px 24px;padding:10px}
</style><div class="test-label">独立交互测试 · 模拟宿主桥接与曲库</div><button id="open" onclick="mount()">打开助手</button><div id="slot"></div><script>
let relay;window.mount=()=>{document.querySelector('#slot').innerHTML='<section class="panel"><header>回声助手<button aria-label="关闭面板" onclick="unmount()">×</button></header><iframe title="回声助手面板" src="/ui/index.html"></iframe></section>'};
window.unmount=()=>{document.querySelector('#slot').innerHTML='';relay?.close();relay=null};window.deliver=event=>relay?.postMessage({event:'plugin',value:{event:'chat',value:event}});window.deliverLibrary=()=>relay?.postMessage({event:'library',value:null});
window.addEventListener('message',event=>{const iframe=document.querySelector('iframe');if(event.source!==iframe?.contentWindow||event.data?.type!=='twilight-experience-ready')return;const channel=new MessageChannel();relay=channel.port1;relay.onmessage=async({data})=>{try{let value;if(data.method==='plugin.request')value=await window.echoRequest(data.args.request);else if(data.method==='host.environment')value=await window.echoEnvironment();else if(data.method==='settings.read')value=await window.echoAppearance();else throw Error('Unexpected method '+data.method);relay?.postMessage({id:data.id,value})}catch(error){relay?.postMessage({id:data.id,error:error.message})}};relay.start();iframe.contentWindow.postMessage({type:'twilight-experience-connect',bridgeVersion:2},'*',[channel.port2])});mount();
</script>`
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`
const context = {
  storagePath: profile, logger: { info() {}, warn() {}, error() {} },
  settings: { get: async key => structuredClone(settings.get(key)), set: async (key, value) => settings.set(key, structuredClone(value)) },
  twilight: {
    experience: { emit: (_name, event) => { void page?.evaluate(event => window.deliver?.(event), event).catch(error => errors.push(error.message)) } },
    library: {
      queryTracks: async ({ offset, limit }) => { await new Promise(resolve => setTimeout(resolve, fixture.delay)); return { revision: fixture.revision, total: fixture.tracks.length, tracks: fixture.tracks.slice(offset, offset + limit) } },
      getTracksByIds: async ids => ({ tracks: fixture.tracks.filter(track => ids.includes(track.id)) })
    },
    appSettings: { get: async () => fixture.settings, update: async patch => { fixture.writes++; Object.assign(fixture.settings, patch); return fixture.settings } },
    player: { getPlaybackInfo: async () => ({ playing: false }) }
  }
}
try {
  gateway = createGateway(context); await gateway.initialize()
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true })
  const browserContext = await browser.newContext({ viewport: { width: 1200, height: 900 } })
  page = await browserContext.newPage()
  page.on('pageerror', error => errors.push(error.stack || error.message))
  await page.exposeFunction('echoRequest', request => gateway.handleRequest(request))
  await page.exposeFunction('echoEnvironment', () => ({ reducedMotion: fixture.reducedMotion }))
  await page.exposeFunction('echoAppearance', () => ({ settings: fixture.settings }))
  await page.goto(origin)
  const frame = page.frameLocator('iframe'), panel = page.locator('.panel')
  const child = () => page.frames().find(frame => frame.url().startsWith(origin + '/ui/'))
  const screenshot = name => panel.screenshot({ path: join(profile, name) })
  const input = frame.getByRole('textbox', { name: '输入消息', exact: true })
  await frame.locator('[data-task="quality"]:not(:disabled)').waitFor()
  assert.equal(await frame.getByText('回声助手', { exact: true }).count(), 0)
  await child().waitForFunction(() => getComputedStyle(document.querySelector('.send-btn')).backgroundColor === 'rgb(37, 99, 235)')
  await screenshot('01-welcome.png'); results.push('420px welcome / four workflows / no duplicate host title')
  await input.fill('主题切换时保留草稿')
  fixture.settings.theme = 'pureWhite'
  await page.evaluate(() => document.documentElement.dataset.tone = 'light')
  await child().evaluate(() => window.dispatchEvent(new Event('focus')))
  await child().waitForFunction(() => getComputedStyle(document.documentElement).backgroundColor === 'rgb(250, 250, 250)')
  assert.equal(await input.inputValue(), '主题切换时保留草稿')
  assert.equal(await frame.locator('.workflow-card').first().evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(255, 255, 255)')
  await child().waitForFunction(() => !document.documentElement.hasAttribute('data-appearance-changing'))
  await screenshot('01b-welcome-light.png')
  fixture.settings.lightAccentColor = 'rose'
  await child().evaluate(() => window.dispatchEvent(new Event('focus')))
  await child().waitForFunction(() => getComputedStyle(document.querySelector('.send-btn')).backgroundColor === 'rgb(225, 29, 72)')
  fixture.settings.lightAccentColor = '#b17b09'
  await child().evaluate(() => window.dispatchEvent(new Event('focus')))
  await child().waitForFunction(() => getComputedStyle(document.querySelector('.send-btn')).backgroundColor === 'rgb(177, 123, 9)')
  assert.equal(await input.inputValue(), '主题切换时保留草稿')
  fixture.settings.lightAccentColor = 'blue'
  await child().evaluate(() => window.dispatchEvent(new Event('focus')))
  await child().waitForFunction(() => getComputedStyle(document.querySelector('.send-btn')).backgroundColor === 'rgb(37, 99, 235)')
  fixture.settings.theme = 'system'; fixture.settings.darkAccentColor = 'amber'
  await page.emulateMedia({ colorScheme: 'dark' })
  await child().evaluate(() => window.dispatchEvent(new Event('focus')))
  await child().waitForFunction(() => getComputedStyle(document.documentElement).backgroundColor === 'rgb(20, 20, 20)' && getComputedStyle(document.querySelector('.send-btn')).backgroundColor === 'rgb(245, 158, 11)')
  await page.emulateMedia({ colorScheme: 'light' })
  await child().waitForFunction(() => getComputedStyle(document.documentElement).backgroundColor === 'rgb(250, 250, 250)' && getComputedStyle(document.querySelector('.send-btn')).backgroundColor === 'rgb(37, 99, 235)')
  fixture.settings.theme = 'pureWhite'; fixture.settings.darkAccentColor = 'blue'
  await child().evaluate(() => window.dispatchEvent(new Event('focus')))
  await child().waitForFunction(() => document.documentElement.dataset.theme === 'light')
  await page.emulateMedia({ colorScheme: 'dark' })
  assert.equal(await child().evaluate(() => getComputedStyle(document.documentElement).backgroundColor), 'rgb(250, 250, 250)')
  assert.equal(await input.inputValue(), '主题切换时保留草稿')
  await page.emulateMedia({ colorScheme: 'light' })
  results.push('host light/dark settings / system mode follows OS / split, named and custom accents / atomic palette switch preserves contrast and draft')
  await frame.locator('[data-task="playlist"]').click()
  assert.equal(await frame.getByLabel('曲目数量', { exact: true }).inputValue(), '20')
  await frame.getByLabel('场景或心情', { exact: true }).fill('雨天阅读')
  await frame.getByLabel('偏爱的风格（可选）', { exact: true }).fill('钢琴')
  await frame.getByRole('button', { name: '填入对话', exact: true }).click()
  assert.match(await input.inputValue(), /20 首.*雨天阅读.*钢琴/)
  assert.equal(modelCalls.length, 0)
  await input.fill('')
  await frame.locator('[data-task="quality"]').click()
  await frame.locator('[data-report="quality"]').waitFor()
  assert.match(await frame.locator('.report-scope').innerText(), /421 \/ 421/)
  assert.equal(modelCalls.length, 0)
  await frame.locator('.distribution summary').click(); await screenshot('02-quality.png')
  results.push('editable playlist prompt / local multi-page report without API / accurate full-library count')
  await frame.getByRole('button', { name: '继续分析', exact: true }).click()
  const dialog = frame.getByRole('dialog')
  await dialog.getByLabel('配置名称', { exact: true }).fill('本地测试模型')
  await dialog.getByLabel('API 地址', { exact: true }).fill(origin + '/v1')
  await dialog.getByRole('button', { name: '获取模型', exact: true }).click()
  await dialog.getByText('已获取 1 个模型，也可手动输入。', { exact: true }).waitFor()
  assert.equal(await dialog.getByLabel('模型名称', { exact: true }).inputValue(), 'echo-smoke')
  await dialog.getByRole('button', { name: '保存配置', exact: true }).click()
  await dialog.getByText('本地测试模型', { exact: true }).waitFor()
  await dialog.getByRole('button', { name: '关闭', exact: true }).click()
  await input.press('Control+Enter')
  await frame.getByText('曲库中的信息值得进一步整理。', { exact: true }).waitFor()
  await frame.getByRole('button', { name: '发送消息', exact: true }).waitFor()
  assert.equal(modelCalls.length, 1)
  assert.ok(modelCalls[0].messages.some(message => String(message.content).includes('扫描 421 / 421')))
  results.push('API setup / model discovery / report context reaches local model / DONE without EOF')
  await input.fill('输入法合成中的中文')
  await input.evaluate(node => node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, isComposing: true, bubbles: true })))
  assert.equal(modelCalls.length, 1); assert.equal(await input.inputValue(), '输入法合成中的中文')
  await input.fill('慢速测试'); await input.press('Control+Enter')
  await frame.locator('.streaming').getByText('这是保留的部分回答。', { exact: true }).waitFor()
  await frame.locator('.user-bubble').getByText('慢速测试', { exact: true }).waitFor()
  await input.fill('正在输入的下一条草稿'); await input.evaluate(node => node.dataset.persistent = 'yes')
  await child().waitForFunction(() => { const node = document.querySelector('.chat-scroll'); return node.scrollHeight > node.clientHeight + 200 })
  await frame.locator('.chat-scroll').evaluate(node => { node.scrollTop = 0; node.dispatchEvent(new Event('scroll')) })
  await page.waitForTimeout(160)
  assert.equal(await frame.locator('.chat-scroll').evaluate(node => node.scrollTop), 0)
  await frame.getByRole('button', { name: '回到最新', exact: true }).click()
  assert.equal(await input.inputValue(), '正在输入的下一条草稿'); assert.equal(await input.getAttribute('data-persistent'), 'yes')
  await input.focus(); await page.waitForTimeout(90)
  assert.equal(await input.evaluate(node => document.activeElement === node), true)
  await page.getByRole('button', { name: '关闭面板', exact: true }).click(); await page.getByRole('button', { name: '打开助手', exact: true }).click()
  await frame.getByRole('button', { name: '停止本轮操作', exact: true }).waitFor()
  assert.equal(await input.inputValue(), '正在输入的下一条草稿')
  await frame.getByRole('button', { name: '停止本轮操作', exact: true }).click()
  await frame.getByRole('button', { name: '发送消息', exact: true }).waitFor()
  await frame.getByText('回答已中断', { exact: true }).waitFor()
  assert.equal(await input.inputValue(), '正在输入的下一条草稿')
  results.push('IME / immediate user message / stable focused draft / history scroll / back to latest / close-reopen active stream / stop retains partial answer')
  await input.fill('确认测试'); await input.press('Control+Enter')
  await frame.getByRole('button', { name: '同意并执行', exact: true }).waitFor()
  await screenshot('03-confirmation.png')
  await page.getByRole('button', { name: '关闭面板', exact: true }).click(); await page.getByRole('button', { name: '打开助手', exact: true }).click()
  await frame.getByRole('button', { name: '同意并执行', exact: true }).waitFor()
  await frame.getByRole('button', { name: '停止本轮操作', exact: true }).click()
  await frame.getByText('本轮已停止，未执行此项确认', { exact: true }).waitFor()
  assert.equal(fixture.writes, 0)
  await input.fill('确认测试'); await input.press('Control+Enter')
  await frame.getByRole('button', { name: '同意并执行', exact: true }).click()
  await frame.getByRole('button', { name: '发送消息', exact: true }).waitFor()
  assert.equal(fixture.writes, 1); assert.equal(fixture.settings.uiDensity, 'compact')
  results.push('pending confirmation survives reopen / stop prevents write / explicit approval applies only fixture change')
  await frame.getByRole('button', { name: '编辑角色提示词', exact: true }).click()
  await dialog.getByLabel('名称', { exact: true }).fill('我的策展助手')
  await dialog.getByLabel('系统提示词 · 角色正文', { exact: true }).fill('请用非常简洁的中文回答，并优先关注爵士。')
  await dialog.getByRole('button', { name: '另存为', exact: true }).click()
  await dialog.getByLabel('角色预设', { exact: true }).locator('option:checked').getByText('我的策展助手 副本', { exact: true }).waitFor({ state: 'attached' })
  await dialog.getByRole('button', { name: '应用到本会话', exact: true }).click()
  await dialog.waitFor({ state: 'detached' })
  await input.fill('确认角色生效'); await input.press('Control+Enter')
  await frame.getByRole('button', { name: '发送消息', exact: true }).waitFor()
  assert.match(modelCalls.at(-1).messages[0].content, /优先关注爵士/)
  await frame.getByRole('button', { name: '助手设置', exact: true }).click()
  await dialog.getByRole('button', { name: '快捷指令', exact: true }).click()
  await dialog.getByRole('button', { name: '新增指令', exact: true }).click()
  await dialog.getByLabel('名称', { exact: true }).last().fill('我的快捷指令')
  await dialog.getByLabel('提示词', { exact: true }).last().fill('帮我挑选三首爵士。')
  await dialog.getByRole('button', { name: '保存快捷指令', exact: true }).click()
  await frame.getByText('快捷指令已保存', { exact: true }).waitFor()
  await dialog.getByRole('button', { name: '关闭', exact: true }).click()
  const count = modelCalls.length
  await frame.getByRole('button', { name: '快捷指令', exact: true }).click()
  await dialog.getByRole('button', { name: /我的快捷指令/ }).click()
  assert.equal(await input.inputValue(), '帮我挑选三首爵士。'); assert.equal(modelCalls.length, count)
  results.push('custom role saved, applied and sent / custom shortcut persists and only fills draft')
  await frame.getByRole('button', { name: '音乐任务', exact: true }).click()
  await frame.locator('[data-task="duplicates"]').click()
  await frame.locator('[data-report="duplicates"]').waitFor()
  assert.match(await frame.locator('.duplicate-count').innerText(), /1 组/)
  await frame.locator('.duplicate-group summary').click()
  await screenshot('04-duplicates.png')
  fixture.delay = 180
  await frame.locator('[data-report="duplicates"]').getByRole('button', { name: '重新检查', exact: true }).click()
  await frame.locator('.scan-count').getByText('200 / 421 首', { exact: true }).waitFor()
  await frame.getByRole('button', { name: '停止本轮操作', exact: true }).click()
  await frame.getByText('部分结果 · 已停止', { exact: true }).waitFor()
  assert.equal(modelCalls.length, count)
  await page.getByRole('button', { name: '关闭面板', exact: true }).click(); await page.getByRole('button', { name: '打开助手', exact: true }).click()
  await frame.getByText('部分结果 · 已停止', { exact: true }).waitFor()
  results.push('duplicate version comparison / cancellable local scan / partial report persists on reopen')
  fixture.revision++
  await page.evaluate(() => window.deliverLibrary())
  await frame.locator('[data-report="quality"] .badge').getByText('结果已过期', { exact: true }).waitFor()
  results.push('library revision notification expires saved reports without losing the draft')
  fixture.reducedMotion = true; fixture.settings.motionPreference = 'reduced'
  await page.getByRole('button', { name: '关闭面板', exact: true }).click(); await page.getByRole('button', { name: '打开助手', exact: true }).click()
  await frame.locator('.send-btn').waitFor()
  await child().waitForFunction(() => document.documentElement.dataset.reducedMotion === 'true')
  assert.equal(await frame.locator('.send-btn').evaluate(node => getComputedStyle(node).transitionDuration), '0s')
  fixture.reducedMotion = false; fixture.settings.motionPreference = 'full'
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await child().evaluate(() => document.documentElement.dataset.reducedMotion = 'false')
  assert.equal(await frame.locator('.send-btn').evaluate(node => getComputedStyle(node).transitionDuration), '0s')
  await page.setViewportSize({ width: 340, height: 740 })
  assert.equal(await child().evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  await screenshot('05-narrow.png')
  await page.setViewportSize({ width: 1200, height: 900 }); await screenshot('06-conversation-light.png')
  fixture.settings.theme = 'dark'
  await page.evaluate(() => document.documentElement.dataset.tone = 'dark')
  await child().evaluate(() => window.dispatchEvent(new Event('focus')))
  await child().waitForFunction(() => getComputedStyle(document.documentElement).backgroundColor === 'rgb(20, 20, 20)')
  await screenshot('07-conversation-dark.png')
  await frame.getByRole('button', { name: '编辑角色提示词', exact: true }).click(); await screenshot('08-settings-dark.png')
  fixture.settings.theme = 'pureWhite'
  await page.evaluate(() => document.documentElement.dataset.tone = 'light')
  await child().evaluate(() => window.dispatchEvent(new Event('focus')))
  await child().waitForFunction(() => getComputedStyle(document.documentElement).backgroundColor === 'rgb(250, 250, 250)')
  await screenshot('09-settings-light.png')
  results.push('340px viewport without horizontal overflow / OS and host reduced-motion / reports, cards and settings in both themes')
  assert.deepEqual(errors, [])
  await writeFile(join(profile, 'result.json'), JSON.stringify({ passed: true, mode: 'playwright-chrome', scope: 'Production UI + real gateway; simulated host bridge and library; local SSE model', results, modelCalls: modelCalls.length, errors }, null, 2))
  console.log(JSON.stringify({ passed: true, profile, results, modelCalls: modelCalls.length }, null, 2))
} catch (error) {
  console.error(error)
  if (page) { await page.screenshot({ path: join(profile, 'failure.png') }).catch(() => {}); await writeFile(join(profile, 'failure.txt'), `${error.stack}\n${errors.join('\n')}`) }
  process.exitCode = 1
} finally {
  await gateway?.dispose(); await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
}
