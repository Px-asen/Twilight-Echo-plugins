import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile, readdir, mkdir, writeFile} from 'node:fs/promises';
import {resolve, extname, sep} from 'node:path';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const output=resolve('.cache/comparison-0.2.14');
const panelsOnly=process.env.RHINE_PANELS_ONLY==='1';
await mkdir(output,{recursive:true});
const roots={original:resolve('../../.cache/visual-reference/downloads-0.2.9/dist'),optimized:resolve('dist')};
const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.webp':'image/webp','.json':'application/json','.woff2':'font/woff2','.glb':'model/gltf-binary'};
const library={version:1,albums:Array.from({length:1000},(_,i)=>({id:'test-'+i,title:'Archive '+i,artist:'Rhine Test',genreId:i%3===2?'instrumental':'ambient',year:2026,coverUrl:'/demo-covers/'+['square','portrait','landscape'][i%3]+'.png',rawGenres:[],folder:'Fixture',tracks:[{id:'track-'+i,albumId:'test-'+i,title:'Silent Test '+i,artist:'Rhine Test',duration:60,format:'WAV',browserPlayable:true,audioUrl:'/silent.wav',relativePath:'silent.wav'}],producers:[],offline:false})),genres:[{id:'ambient',name:'氛围音乐'},{id:'instrumental',name:'器乐'}],roots:[],scan:{running:false},onlineEnabled:false};
let active='original';
const server=createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost');
  if(url.pathname.startsWith('/api/')){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(url.pathname==='/api/library'?library:{ok:true,outputs:[],devices:[]}));return;}
  const root=roots[active],file=resolve(root,'.'+(url.pathname==='/'?'/index.html':decodeURIComponent(url.pathname)));
  if(!file.startsWith(root+sep)){res.writeHead(403).end();return;}
  try{
    let body=await readFile(file);
    if(/music-app-[\w-]+\.js$/.test(file)){
      const source=body.toString(),pattern=/(\b[A-Za-z_$][\w$]*)=new ([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\("#three-scene"\)\),\1\.setMusicArrayMode\(/g;
      const matches=[...source.matchAll(pattern)];assert.equal(matches.length,1,'Unique scene handle');
      body=Buffer.from(source.replace(pattern,(_,v,cls,query)=>`${v}=window.__benchScene=new ${cls}(${query}("#three-scene")),${v}.setMusicArrayMode(`));
    }
    res.writeHead(200,{'Content-Type':types[extname(file)]||'application/octet-stream','Cache-Control':'no-store'});res.end(body);
  }catch(e){res.writeHead(404).end(String(e));}
});
await new Promise(done=>server.listen(0,'127.0.0.1',done));
const browser=await chromium.launch({channel:'msedge',headless:true,args:['--use-angle=d3d11','--disable-backgrounding-occluded-windows']});
const results=[];
try{
  for(const label of ['original','optimized']){
    active=label;
    const context=await browser.newContext({viewport:{width:1920,height:1080},deviceScaleFactor:1.5});
    const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(String(e.stack)));
    await page.addInitScript(()=>{
      localStorage.setItem('rhine-music-preferences',JSON.stringify({quality:'original',reduced:true,bgm:false,sound:false,defaultCover:false}));
      window.__nativeRAF=requestAnimationFrame.bind(window);
      window.requestAnimationFrame=cb=>window.__pauseRAF?0:window.__nativeRAF(cb);
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/?lab=0`);
    await page.locator('#three-scene canvas').waitFor({timeout:120000});
    if(await page.locator('.rhine-loading').isVisible())await page.locator('.rhine-loading').press('Enter');
    await page.locator('.rhine-loading').waitFor({state:'hidden',timeout:120000});
    if(await page.locator('.music-boot-skip').isVisible())await page.locator('.music-boot-skip').click();
    await page.locator('#stage[data-music-boot=done]').waitFor({timeout:60000});
    await page.waitForFunction(()=>window.__benchScene?.getStats().loaded);
    console.log(label+' ready');
    if(!panelsOnly)await page.evaluate(async()=>{
      window.__pauseRAF=true;await new Promise(window.__nativeRAF);await new Promise(window.__nativeRAF);
      const s=window.__benchScene;window.__clock=Math.max(s.last||0,performance.now()/1000)+1;
      for(let i=0;i<240;i++)s.update(window.__clock+=1/60,undefined,false);
      await s.covers.prepareVisible(3000);
      for(let i=0;i<16;i++){s.covers.flushUploads(s.renderer,64);s.update(window.__clock+=1/60);await new Promise(window.__nativeRAF);}
    });
    const panels=[];
    async function capture(name){
      await page.waitForTimeout(350);
      panels.push({name,...await page.evaluate(()=>({
        controls:[...document.querySelectorAll('#music-panel-root button,#music-panel-root input,#music-panel-root select,#music-detail button,#music-lyrics button')].map(e=>({tag:e.tagName,id:e.id,action:e.dataset.action||'',quality:e.dataset.quality||'',label:e.getAttribute('aria-label')||e.textContent.trim(),type:e.type,options:e.options?[...e.options].map(o=>({value:o.value,text:o.text})):undefined})),
        text:document.querySelector('#music-panel-root')?.textContent,stage:{...document.querySelector('#stage').dataset},quality:JSON.parse(document.querySelector('#three-scene').dataset.renderQuality),presentation:window.rhineMusic.presentation
      }))});
      await page.screenshot({path:resolve(output,`${label}-${name}.png`)});
    }
    await capture('archive');
    await page.locator('[data-action="settings"]').dispatchEvent('click');
    await capture('settings-library');
    await page.locator('#settings-tab-display').click();
    await page.locator('.quality-advanced summary').click();
    await capture('settings-display');
    if(label==='optimized'){
      await page.locator('#quality-preset').selectOption('performance');
      assert.equal(await page.locator('#quality-profile-note').getAttribute('data-quality-profile'),'performance');
      assert.match(await page.locator('#quality-profile-note').textContent(),/降低画面清晰度/);
      await capture('settings-low');
      await page.locator('#quality-preset').selectOption('original');
    }
    await page.locator('[data-action="close-panel"]').dispatchEvent('click');
    await page.locator('[data-action="search"]').dispatchEvent('click');
    await page.locator('#album-search').fill('Archive 999');
    await capture('search');
    await page.locator('[data-action="close-panel"]').dispatchEvent('click');
    await page.locator('#stage').dispatchEvent('keydown',{key:'Enter',bubbles:true});
    if(!panelsOnly)await page.evaluate(()=>{for(let i=0;i<180;i++)window.__benchScene.update(window.__clock+=1/60,undefined,false);});
    else await page.locator('#music-detail[data-transition="open"]').waitFor();
    await capture('detail');
    if(panelsOnly){
      await page.locator('#open-lyrics').click();
      await page.locator('#music-lyrics[data-transition="open"]').waitFor();
      await capture('lyrics');
      await page.locator('[data-action="close-lyrics"]').click();
      await page.locator('#music-lyrics').waitFor({state:'hidden'});
    }
    await page.locator('#stage').dispatchEvent('keydown',{key:'Escape',bubbles:true});
    if(panelsOnly){
      await page.locator('#stage').dispatchEvent('keydown',{key:'v',bubbles:true});
      await capture('overview');
    }
    // Per-frame GPU duration is independent of the original's uncapped RAF.
    const gpu=panelsOnly?{rows:[],error:0,disjoint:false}:await page.evaluate(async()=>{
      const s=window.__benchScene,r=s.renderer,gl=r.getContext(),ext=gl.getExtension('EXT_disjoint_timer_query_webgl2');
      if(!ext)throw Error('GPU timer unavailable');
      const summarize=values=>{const a=values.slice().sort((x,y)=>x-y);return{median:a[Math.floor(a.length*.5)],p90:a[Math.floor(a.length*.9)],samples:a.length};};
      const rows=[];
      async function sample(theme,moving,profile,round){
        s.setTheme(theme);s.setReduced(!moving);
        for(let i=0;i<180;i++)s.update(window.__clock+=1/60,undefined,false);
        for(let i=0;i<12;i++){s.update(window.__clock+=1/60);await new Promise(window.__nativeRAF);}
        const queries=[],cpu=[];
        for(let i=0;i<64;i++){
          const q=gl.createQuery();gl.beginQuery(ext.TIME_ELAPSED_EXT,q);
          const start=performance.now();s.update(window.__clock+=1/60);cpu.push(performance.now()-start);
          gl.endQuery(ext.TIME_ELAPSED_EXT);queries.push(q);await new Promise(window.__nativeRAF);
        }
        gl.finish();await new Promise(window.__nativeRAF);
        const times=queries.filter(q=>gl.getQueryParameter(q,gl.QUERY_RESULT_AVAILABLE)).map(q=>gl.getQueryParameter(q,gl.QUERY_RESULT)/1e6);
        queries.forEach(q=>gl.deleteQuery(q));assertAvailable(times);
        rows.push({theme,moving,profile,round,gpu:summarize(times),cpu:summarize(cpu),stats:s.getStats(),quality:JSON.parse(document.querySelector('#three-scene').dataset.renderQuality),targets:s.composer.passes.map(p=>({type:p.constructor.name,enabled:p.enabled,targets:Object.entries(p).filter(([k,v])=>v?.isWebGLRenderTarget).map(([key,v])=>({key,width:v.width,height:v.height,format:v.texture.format,type:v.texture.type,depth:v.depthBuffer}))}))});
      }
      function assertAvailable(times){if(times.length!==64)throw Error('Incomplete GPU timing');}
      const quality={...s.quality};
      for(let round=0;round<2;round++)for(const theme of ['day','night'])for(const moving of [false,true])await sample(theme,moving,'original',round);
      if(s.quality.modelDetail){
        s.setQuality({frameRate:60,modelDetail:'auto',scale:80,pixelRatio:1,antialias:'fxaa',shadows:1024,aoSamples:0,aoResolution:.5,depthOfField:0,transmission:.5,anisotropy:4});
        for(const theme of ['day','night'])for(const moving of [false,true])await sample(theme,moving,'performance',0);
        s.setQuality(quality);
      }
      return{rows,error:gl.getError(),disjoint:gl.getParameter(ext.GPU_DISJOINT_EXT)};
    });
    assert.equal(gpu.error,0);assert.equal(gpu.disjoint,false);assert.deepEqual(errors,[]);
    const result={label,root:roots[label],viewport:{width:1920,height:1080,dpr:1.5},fixture:{albums:1000,uniqueCoverURLs:3},panels,gpu,errors};
    results.push(result);await writeFile(resolve(output,label+(panelsOnly?'-panels':'')+'.json'),JSON.stringify(result,null,2));
    console.log(label,JSON.stringify(gpu.rows.map(r=>({theme:r.theme,moving:r.moving,profile:r.profile,round:r.round,gpu:r.gpu.median,cpu:r.cpu.median,covers:r.stats.covers,triangles:r.stats.triangles}))));
    await context.close();
  }
  const base=results[0].panels.find(p=>p.name==='settings-display').controls,newer=results[1].panels.find(p=>p.name==='settings-display').controls;
  const key=c=>c.id||c.quality||c.action||c.label;
  const removed=base.filter(a=>!newer.some(b=>key(a)===key(b)));
  assert.deepEqual(removed,[],'Existing settings controls retained');
  const diff={removed,added:newer.filter(b=>!base.some(a=>key(a)===key(b))),unchangedCSS:[]};
  for(const file of (await readdir(resolve(roots.original,'assets'))).filter(f=>f.endsWith('.css'))){assert.deepEqual(await readFile(resolve(roots.original,'assets',file)),await readFile(resolve(roots.optimized,'assets',file)));diff.unchangedCSS.push(file);}
  for(const panel of results[0].panels){
    const next=results[1].panels.find(p=>p.name===panel.name);assert.ok(next);
    const missing=panel.controls.filter(a=>!next.controls.some(b=>key(a)===key(b)));
    assert.deepEqual(missing,[],panel.name+' controls retained');
  }
  await writeFile(resolve(output,'controls-diff.json'),JSON.stringify(diff,null,2));
  console.log('UI controls and CSS verified',JSON.stringify(diff));
}finally{await browser.close();await new Promise(done=>server.close(done));}
