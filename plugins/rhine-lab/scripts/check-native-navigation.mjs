import { mkdir, writeFile, cp, readFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { _electron: electron } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const profile = resolve('.cache/rhine-performance-' + (process.env.RHINE_PERF_LABEL || 'baseline') + '-' + Date.now())
const pluginRoot = resolve('../Twilight-Echo-plugins/plugins/rhine-lab')
const manifest = JSON.parse(await readFile(join(pluginRoot, 'plugin.json'), 'utf8'))
if(process.env.RHINE_PERF_VERSION) manifest.version=process.env.RHINE_PERF_VERSION;
await mkdir(profile, { recursive: true })
const media = join(profile, 'media')
await mkdir(media, { recursive: true })
await mkdir(join(profile, 'cover-cache'), { recursive: true })
const tracks = []
await cp(join(pluginRoot, 'public/demo-covers/square.png'), join(media, 'cover.png'))
const fixtureCount = Number(process.env.RHINE_PERF_ALBUMS || 3);
for (let index=0;index<fixtureCount;index++) {
  const cover=['square','portrait','landscape'][index%3];
  const data = Buffer.alloc(44100 * 2 * (fixtureCount>3 ? .25 : 60))
  const header = Buffer.alloc(44)
  header.write('RIFF'); header.writeUInt32LE(data.length + 36, 4); header.write('WAVE', 8)
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22); header.writeUInt32LE(44100, 24); header.writeUInt32LE(88200, 28)
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(data.length, 40)
  const fileName = `silent-${index}.wav`
  const filePath = join(media, fileName)
  const genre=fixtureCount>3?'Genre '+(index%12):'Ambient';
  const infoChunks = Object.entries({ INAM: 'Silent Test '+(index+1), IART: 'Rhine Test', IPRD: 'Archive '+(index+1), IGNR: genre, ICRD: '2026' }).map(([key,value])=>{const text=Buffer.from(value+'\0');const h=Buffer.alloc(8);h.write(key);h.writeUInt32LE(text.length,4);return Buffer.concat([h,text,...(text.length%2?[Buffer.alloc(1)]:[])]);});
  const info=Buffer.concat([Buffer.from('INFO'),...infoChunks]);const list=Buffer.alloc(8);list.write('LIST');list.writeUInt32LE(info.length,4);header.writeUInt32LE(data.length+36+list.length+info.length,4);
  await writeFile(filePath, Buffer.concat([header, data, list, info]))
  await writeFile(join(media, `silent-${index}.lrc`), '[00:00.00]Rhine Test\n[00:05.00]Silent playback')
  if(index<3) await cp(join(pluginRoot, 'public/demo-covers', `${cover}.png`), join(profile, 'cover-cache', `${cover}.png`))
  tracks.push({ id: `rhine-test-${index}`, title: `Silent Test ${index + 1}`, artist: 'Rhine Test',
    album: `Archive ${index + 1}`, albumArtist: 'Rhine Test', genre, fileName, filePath,
    dir: media, duration: 60, size: data.length + 44, format: 'WAV', sampleRate: 44100, bitDepth: 16,
    trackNumber: 1, discNumber: 1, cover: `cover://${cover}.png`, lyrics: '[00:00.00]Rhine Test\n[00:05.00]Silent playback' })
}
await writeFile(join(profile, 'music-library.json'), JSON.stringify({ version: 2, revision: 1, tracks, folders: [media], exclusions: [] }))
await writeFile(join(profile, 'settings.json'), JSON.stringify({ onboardingCompleted: true, startupHomePage: 'local', libraryFolders: [media], volume: 0 }))
const packageFile = resolve('../Twilight-Echo-plugins/packages', `${manifest.id}-${manifest.version}.tep`)
const env = { ...process.env, RHINE_TEST_PROFILE: profile }
delete env.ELECTRON_RUN_AS_NODE
const nativePackage = process.env.RHINE_TEST_NATIVE_PACKAGE === '1' && process.env.RHINE_TEST_PACKAGE;
const app = await electron.launch({ executablePath: nativePackage ? join(nativePackage,'TwilightEcho.exe') : require('electron'), args: [...(nativePackage ? ['--user-data-dir='+profile] : [resolve('scripts/rhine-experience-bootstrap.cjs')]), '--mute-audio', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--disable-background-timer-throttling', '--disable-features=CalculateNativeWinOcclusion', ...(process.env.RHINE_TEST_ANGLE ? ['--use-angle='+process.env.RHINE_TEST_ANGLE] : [])], env, timeout: 60000 })
const errors = []
let page
try {
  page = await app.firstWindow()
  page.setDefaultTimeout(30000)
  page.on('pageerror', error => { errors.push(error.stack || error.message); console.log('pageerror',error.stack); })
  page.on('console', message => { if (message.type() === 'error') console.log('renderer:', message.text().slice(0,400)) })
  await app.evaluate(({BrowserWindow}) => { for(const w of BrowserWindow.getAllWindows()) w.webContents.setBackgroundThrottling(false); });
  await page.waitForFunction(() => !!window.api?.plugins, { timeout: 60000 })
  const runtime = await app.evaluate(({app}) => ({packaged:app.isPackaged,profile:app.getPath('userData'),appPath:app.getAppPath()}));
  if(resolve(runtime.profile)!==profile)throw Error('Test profile isolation failed');
  if(nativePackage && !runtime.packaged)throw Error('Expected packaged executable');
  console.log('runtime',runtime);
  await app.evaluate(({ dialog }, packageFile) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [packageFile] })
    dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false })
  }, packageFile)
  await app.evaluate(({dialog},file)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:file});},join(profile,'agent.md'));
  const installation = await page.evaluate(() => window.api.plugins.chooseAndInstall('package'))
  console.log('package installed', installation.plugin.id)
  const enabled = await page.evaluate(id => window.api.plugins.enable(id), manifest.id)
  if(process.env.RHINE_TEST_QUALITY || process.env.RHINE_PERF_ARRAY_MODE) {
    await page.evaluate(({id,quality,arrayMode})=>window.api.extensions.experiencePreferences(id, {
      localPreferences: {'rhine-music-preferences': JSON.stringify({quality, arrayMode})}
    }),{id:manifest.id,quality:process.env.RHINE_TEST_QUALITY||'original',arrayMode:process.env.RHINE_PERF_ARRAY_MODE||'filled'});
  }
  console.log('enabled', enabled.id, enabled.status)
  console.log('experiences', await page.evaluate(() => window.api.extensions.experiences()))
  await page.getByText('莱茵生命', { exact: true }).first().dispatchEvent('click')
  console.log('entered', page.frames().map(frame => frame.url()))
  await page.bringToFront();
  const frame = page.frameLocator('.experience-window iframe')

  await frame.locator('#three-scene canvas').waitFor({timeout: 60000});
  await app.evaluate(({webContents}) => { for(const contents of webContents.getAllWebContents()) contents.setBackgroundThrottling(false); });
  if(process.env.RHINE_TEST_FULL_OPENING === '1') {
    const openingFrame = page.frames().find(frame => frame.url().startsWith('plugin-ui:'));
    await openingFrame.waitForFunction(() => Number(document.querySelector('.opening-stage')?.dataset.bootFrame) >= 605, undefined, { timeout: 60000 });
    const gated = await openingFrame.evaluate(() => ({inert:document.querySelector('#stage').inert, text:document.querySelector('.welcome-company').textContent}));
    if(!gated.inert || !gated.text.includes('TWILIGHT ECHO')) throw Error('Opening text/readiness isolation failed');
    await page.screenshot({path:join(profile,'twilight-opening.png')});
  } else if(await frame.locator('.rhine-loading').isVisible()) await frame.locator('.rhine-loading').press('Enter');
  await frame.locator('.rhine-loading').waitFor({state:'hidden',timeout:120000});
  if(await frame.locator('.music-boot-skip').isVisible()) await frame.locator('.music-boot-skip').click();
  await frame.locator('#stage[data-music-boot=done]').waitFor({timeout:30000});
  console.log('boot done');

  const child = page.frames().find(frame=>frame.url().startsWith('plugin-ui:'));
  const libraryAlbums=await child.evaluate(()=>window.rhineMusic.library.albums.length);
  if(libraryAlbums!==fixtureCount) throw Error(`Expected ${fixtureCount} actual albums, got ${libraryAlbums}`);
  const gpu = await app.evaluate(async({app})=>({status:app.getGPUFeatureStatus(),info:await app.getGPUInfo('basic')}));
  gpu.webgl=await child.evaluate(()=>{
    const gl=document.querySelector('#three-scene canvas').getContext('webgl2'),extension=gl.getExtension('WEBGL_debug_renderer_info');
    return {version:gl.getParameter(gl.VERSION),renderer:extension?gl.getParameter(extension.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER),devicePixelRatio};
  });
  const runs = [];
  for (const [width,height] of (process.env.RHINE_PERF_STRESS ? [[1920,1080]] : [[1366,768],[1920,1080]])) {
    await page.setViewportSize({width,height});
    await page.waitForTimeout(1500);
    for (const theme of ['day','night']) for(const scenario of (process.env.RHINE_PERF_POINTER ? ['pointer'] : process.env.RHINE_PERF_STRESS ? ['rapid-reverse','columns','overview','detail'] : ['rows'])) {
      await child.evaluate(scenario=>{
        const stage=document.querySelector('#stage');
        stage.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
        if(scenario==='overview')stage.dispatchEvent(new KeyboardEvent('keydown',{key:'v',bubbles:true}));
        if(scenario==='detail')stage.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
      },scenario);
      await frame.locator('button[data-theme="'+theme+'"]').dispatchEvent('click');
      await page.waitForTimeout(1800);
      await page.bringToFront();
      await app.evaluate(({BrowserWindow}) => {
        for (const w of BrowserWindow.getAllWindows()) {
          w.webContents.setBackgroundThrottling(false);
          if (w.isMinimized()) w.restore();
          w.show(); w.focus();
        }
      });
      const session = await page.context().newCDPSession(child);
      await session.send('Profiler.enable');
      await session.send('Profiler.start');
      const measured = await child.evaluate(async(scenario)=>{
        const gaps=[];let previous,start;let lastMove=-1000;
        const before=window.rhineMusic.stats(), visibilityBefore=document.visibilityState;
        await new Promise(resolve=>{
          function sample(now){
            start??=now;
            if(previous!==undefined)gaps.push(now-previous);
            previous=now;
            if(scenario==='pointer'){
              const canvas=document.querySelector('#three-scene canvas'),rect=canvas.getBoundingClientRect();
              for(let i=0;i<8;i++) canvas.dispatchEvent(new PointerEvent('pointermove',{clientX:rect.left+rect.width*(.5+.45*Math.sin((now+i)/400)),clientY:rect.top+rect.height*(.5+.4*Math.cos((now+i)/700)),pointerType:'mouse',pointerId:1,bubbles:true}));
            } else if(now-start-lastMove>(scenario==='rapid-reverse'?120:650)){
              lastMove=now-start;
              const keys=scenario==='columns'?['ArrowRight','ArrowLeft']:['ArrowDown','ArrowUp'];
              document.querySelector('#stage').dispatchEvent(new KeyboardEvent('keydown',{key:keys[Math.floor(lastMove/(scenario==='rapid-reverse'?360:2600))%2],bubbles:true}));
            }
            if(now-start<6500)requestAnimationFrame(sample);else resolve();
          }
          requestAnimationFrame(sample);
        });
        const sorted=[...gaps].sort((a,b)=>a-b), duration=gaps.reduce((a,b)=>a+b,0);
        return {frames:gaps.length,fps:1000*gaps.length/duration,p50:sorted[Math.floor(sorted.length*.5)],p95:sorted[Math.floor(sorted.length*.95)],p99:sorted[Math.floor(sorted.length*.99)],over50ms:gaps.filter(x=>x>50).length,visibilityBefore,visibilityAfter:document.visibilityState,libraryAlbums:window.rhineMusic.library.albums.length,before,stats:window.rhineMusic.stats(),timing:JSON.parse(document.querySelector('#three-scene').dataset.frameTiming||'{}'),quality:JSON.parse(document.querySelector('#three-scene').dataset.renderQuality||'{}')};
      },scenario);
      if(measured.visibilityBefore!=='visible'||measured.visibilityAfter!=='visible'||measured.fps<5) throw Error('Occluded/hidden performance sample is invalid: '+JSON.stringify(measured));
      const {profile:cpu} = await session.send('Profiler.stop');
      await session.detach();
      await writeFile(join(profile,`cpu-${width}-${theme}-${scenario}.json`),JSON.stringify(cpu));
      const hot=cpu.nodes.filter(n=>n.hitCount).sort((a,b)=>b.hitCount-a.hitCount).slice(0,18).map(n=>({name:n.callFrame.functionName,url:n.callFrame.url.split('/').pop(),hits:n.hitCount}));
      runs.push({width,height,theme,scenario,...measured,hot});
      console.log(JSON.stringify({width,height,theme,scenario,albums:tracks.length,fps:measured.fps,p95:measured.p95,p99:measured.p99,drawCalls:measured.stats.drawCalls,triangles:measured.stats.triangles,cpu:measured.timing.cpuP95,hot:hot.slice(0,5)}));
    }
  }
  if(errors.length) throw Error(errors.join('\n'));
  await writeFile(join(profile,'performance.json'),JSON.stringify({profile,version:manifest.version,albumCount:tracks.length,gpu,runs,errors},null,2));
  console.log('PERFORMANCE_RESULT '+join(profile,'performance.json'));
} finally { const timer=setTimeout(()=>app.process().kill(),10000);await app.close();clearTimeout(timer); }
