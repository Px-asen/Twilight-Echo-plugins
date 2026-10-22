import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import assert from 'node:assert/strict';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = resolve(process.env.RHINE_REFERENCE_ROOT || '../../.cache/visual-reference/downloads-0.2.9/dist');
const label = process.env.RHINE_CAPTURE || 'downloads-0.2.9';
const output = resolve('.cache/visual-reference', label);
await mkdir(output, { recursive: true });
const mime = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.svg':'image/svg+xml', '.png':'image/png', '.webp':'image/webp', '.json':'application/json', '.woff2':'font/woff2', '.glb':'model/gltf-binary' };
const server = createServer(async (req,res) => {
  const file = resolve(root, '.' + decodeURIComponent(new URL(req.url,'http://localhost').pathname === '/' ? '/index.html' : new URL(req.url,'http://localhost').pathname));
  if(!file.startsWith(root+sep)) { res.writeHead(403).end(); return; }
  try { res.writeHead(200,{'Content-Type':mime[extname(file)] || 'application/octet-stream'});res.end(await readFile(file)); }
  catch { res.writeHead(404).end(); }
});
await new Promise(done=>server.listen(0,'127.0.0.1',done));
const browser = await chromium.launch({channel:'msedge',headless:true,args:['--use-angle=d3d11']});
try {
  const page = await browser.newPage({viewport:{width:1440,height:900},deviceScaleFactor:1.5});
  const errors=[];page.on('pageerror',e=>errors.push(String(e.stack)));
  const preferences={quality:'original',reduced:true,bgm:false,sound:false,...JSON.parse(process.env.RHINE_REFERENCE_PREFERENCES || '{}')};
  await page.addInitScript(p=>localStorage.setItem('rhine-music-preferences',JSON.stringify(p)),preferences);
  await page.goto(`http://127.0.0.1:${server.address().port}/?demo=1&lab=0`);
  await page.locator('#three-scene canvas').waitFor({timeout:120000});
  if(await page.locator('.rhine-loading').isVisible())await page.locator('.rhine-loading').press('Enter');
  await page.locator('.rhine-loading').waitFor({state:'hidden',timeout:120000});
  if(await page.locator('.music-boot-skip').isVisible())await page.locator('.music-boot-skip').click();
  await page.locator('#stage[data-music-boot=done]').waitFor({timeout:60000});
  console.log(label+' ready');
  const rows=[];
  for(const theme of ['day','night']) {
    await page.locator(`button[data-theme="${theme}"]`).dispatchEvent('click');
    for(const scenario of ['archive','detail']) {
      await page.locator('#stage').dispatchEvent('keydown',{key:scenario==='archive'?'Escape':'Enter',bubbles:true});
      await page.waitForTimeout(2200);
      const row=await page.evaluate(()=>({stats:window.rhineMusic.stats(),quality:JSON.parse(document.querySelector('#three-scene').dataset.renderQuality),viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio},presentation:window.rhineMusic.presentation}));
      rows.push({theme,scenario,...row});
      await page.screenshot({path:resolve(output,`${theme}-${scenario}.png`)});
      console.log(label,theme,scenario,JSON.stringify(row.quality));
    }
  }
  assert.deepEqual(errors,[]);
  const saved=await page.evaluate(()=>JSON.parse(localStorage.getItem('rhine-music-preferences')));
  if(label==='restored-0.2.13') {
    assert.equal(saved.renderQualityRevision,1);
    assert.equal(saved.renderQuality.pixelRatio,1.5);
    assert.equal(saved.renderQuality.modelDetail,'full');
  }
  await writeFile(resolve(output,'result.json'),JSON.stringify({label,root,preferences,saved,rows,errors},null,2));
} finally { await browser.close(); await new Promise(done=>server.close(done)); }
