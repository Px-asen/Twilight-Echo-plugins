import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.RHINE_TEST_URL || 'http://127.0.0.1:5322';
const label = process.env.RHINE_CAPTURE || 'gpu';
const root = '.cache/gpu-cost';
await mkdir(root, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: true,
  args: ['--use-angle=d3d11', '--disable-backgrounding-occluded-windows'] });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
const errors = [];
page.on('pageerror', e => errors.push(String(e.stack)));
page.on('console', m => { if(m.type()==='error') console.log(m.text().slice(0,400)); });
await page.route(base + '/@vite/client',route=>route.fulfill({contentType:'text/javascript',body:''}));
await page.route(base + '/__gpu', route => route.fulfill({ contentType: 'text/html', body: `
<style>html,body,#stage,#three-scene{margin:0;width:100%;height:100%;overflow:hidden}</style>
<main id="stage"><div id="three-scene"></div></main><script type="module">
import { ArchiveScene } from '/src/scene.ts';
import { setMusicAlbums } from '/src/data.ts';
import { demoAlbums,demoGenres } from '/src/demo-library.ts';
import { qualityPresets } from '/src/render-quality.ts';
setMusicAlbums(Array.from({length:1000},(_,i)=>({...demoAlbums[i%3],id:'test-'+i,title:'Archive '+i})),demoGenres);
const s = new ArchiveScene(document.querySelector('#three-scene')); s.enableSelectionLighting();
await s.load(); s.setQuality(qualityPresets.original); s.setReduced(true);
await s.prepareMusicRenderer(); s.showMusicArchiveImmediately(performance.now()/1000);
window.testClock=performance.now()/1000+1;
for(let i=0;i<300;i++) s.update(window.testClock+=1/60,undefined,false);
await s.covers.prepareVisible(3000); for(let i=0;i<12;i++) s.covers.flushUploads(s.renderer,64);
for(let i=0;i<4;i++) s.update(window.testClock+=1/60);
window.testScene=s;
</script>` }));
try {
  await page.goto(base + '/__gpu');
  await page.waitForFunction(() => window.testScene, undefined, { timeout: 120000 });
  console.log('Scene ready');
  const result = await page.evaluate(async () => {
    const s = window.testScene, r=s.renderer, gl=r.getContext();
    const ext=gl.getExtension('EXT_disjoint_timer_query_webgl2');
    if(!ext) throw Error('GPU timer unavailable');
    const summary = list => {
      list.sort((a,b)=>a-b);
      return { median:list[Math.floor(list.length*.5)], p90:list[Math.floor(list.length*.9)], samples:list.length };
    };
    async function sample(moving, reference=false) {
      s.setReduced(!moving);
      if('prepassEnabled' in s.composer.passes[0]) s.composer.passes[0].prepassEnabled=!reference;
      for(let i=0;i<8;i++){s.update(window.testClock+=1/60);await new Promise(requestAnimationFrame);}
      const qs=[],cpu=[];
      const passes=s.composer.passes.filter(p=>p.enabled);
      const originals=passes.map(p=>p.render);
      const passQueries=passes.map(()=>[]);
      passes.forEach((p,index)=>{
        p.render=function(...args){
          const q=gl.createQuery(); gl.beginQuery(ext.TIME_ELAPSED_EXT,q);
          try { return originals[index].apply(this,args); }
          finally { gl.endQuery(ext.TIME_ELAPSED_EXT); passQueries[index].push(q); }
        };
      });
      try {
        for(let i=0;i<48;i++) {
          const start=performance.now(); s.update(window.testClock+=1/60); cpu.push(performance.now()-start);
          await new Promise(requestAnimationFrame);
        }
      } finally { passes.forEach((p,i)=>p.render=originals[i]); }
      gl.finish(); await new Promise(requestAnimationFrame);
      const passCosts=passes.map((p,i)=>{
        const times=passQueries[i].filter(q=>gl.getQueryParameter(q,gl.QUERY_RESULT_AVAILABLE))
          .map(q=>gl.getQueryParameter(q,gl.QUERY_RESULT)/1e6);
        passQueries[i].forEach(q=>gl.deleteQuery(q));
        return {name:p.constructor.name,...summary(times)};
      });
      return { moving,reference,passes:passCosts,gpuMs:passCosts.reduce((n,p)=>n+p.median,0),cpu:summary(cpu),stats:s.getStats() };
    }
    const rows=[], pixels=[];
    const read=()=>{ const data=new Uint8Array(gl.drawingBufferWidth*gl.drawingBufferHeight*4);gl.readPixels(0,0,gl.drawingBufferWidth,gl.drawingBufferHeight,gl.RGBA,gl.UNSIGNED_BYTE,data);return data; };
    const compare=(a,b)=>{let max=0,sum=0,changed=0;for(let i=0;i<a.length;i++){const d=Math.abs(a[i]-b[i]);max=Math.max(max,d);sum+=d;if(d>8)changed++;}return{max,mean:sum/a.length,over8:changed/a.length};};
    for(const theme of ['day','night']){
      s.setReduced(true);s.setTheme(theme); for(let i=0;i<240;i++)s.update(window.testClock+=1/60,undefined,false);
      if('prepassEnabled' in s.composer.passes[0]){
        const pass=s.composer.passes[0];const quality={...s.quality};s.setQuality({...quality,antialias:'off'});
        pass.prepassEnabled=false;s.composer.render();const before=read();
        pass.prepassEnabled=true;s.composer.render();const after=read();
        pixels.push({theme,...compare(before,after)});s.setQuality(quality);
      }
      for(const reference of ('prepassEnabled' in s.composer.passes[0] ? [true,false] : [false])) {
        rows.push({theme,...await sample(false,reference)});
        rows.push({theme,...await sample(true,reference)});
        s.setReduced(true);for(let i=0;i<240;i++)s.update(window.testClock+=1/60,undefined,false);
      }
    }
    s.setReduced(true);
    const aoPixels=[], originalAoPixels=[];
    if(s.ao.copyMaterial.uniforms.copyOcclusion){
      const {RGBAFormat,RedFormat}=await import('/node_modules/three/build/three.module.js');
      s.composer.render();const scalar=read();
      for(const target of [s.ao.ssaoRenderTarget,s.ao.blurRenderTarget]){target.dispose();target.texture.format=RGBAFormat;target.depthBuffer=true;}
      s.ao.invalidate();s.composer.render();aoPixels.push(compare(scalar,read()));
      for(const target of [s.ao.ssaoRenderTarget,s.ao.blurRenderTarget]){target.dispose();target.texture.format=RedFormat;target.depthBuffer=false;}
      s.ao.invalidate();
    }
    // Compare against Three's original pass, including the authored translucent
    // contact-shadow mix. Comparing two formats of our own shader missed this.
    const {SSAOPass}=await import('/node_modules/three/examples/jsm/postprocessing/SSAOPass.js');
    const cached=s.ao, baseline=new SSAOPass(s.scene,s.camera,cached.width,cached.height,s.quality.aoSamples);
    baseline.kernelRadius=cached.kernelRadius;baseline.minDistance=cached.minDistance;baseline.maxDistance=cached.maxDistance;
    baseline.ssaoMaterial.uniforms.kernel.value=cached.kernel;
    baseline.ssaoMaterial.uniforms.tNoise.value=cached.noiseTexture;
    baseline.copyMaterial.fragmentShader=baseline.copyMaterial.fragmentShader.replace(
      'gl_FragColor = opacity * texel;',
      'gl_FragColor = vec4(mix(vec3(1.0), texel.rgb, 0.22), texel.a);');
    baseline.ssaoMaterial.uniforms.cameraProjectionMatrix.value.copy(s.camera.projectionMatrix);
    baseline.ssaoMaterial.uniforms.cameraInverseProjectionMatrix.value.copy(s.camera.projectionMatrixInverse);
    const aoIndex=s.composer.passes.indexOf(cached);
    for(const theme of ['day','night']){
      s.setTheme(theme);for(let i=0;i<240;i++)s.update(window.testClock+=1/60,undefined,false);
      cached.invalidate();s.composer.render();const optimized=read();
      s.composer.passes[aoIndex]=baseline;s.ao=baseline;s.composer.render();
      originalAoPixels.push({theme,...compare(optimized,read())});
      s.composer.passes[aoIndex]=cached;s.ao=cached;
    }
    baseline.dispose();baseline.noiseTexture.dispose();baseline.ssaoMaterial.dispose();cached.invalidate();
    for(const scenario of ['overview','detail','realistic']){
      if(scenario==='overview')s.setMusicOverview(true);
      if(scenario==='detail'){s.setMusicOverview(false);s.setMode('detail');}
      if(scenario==='realistic'){s.setMode('archive');s.setMusicArrayMode('realistic');}
      for(let i=0;i<300;i++)s.update(window.testClock+=1/60,undefined,false);
      const pass=s.composer.passes[0];pass.prepassEnabled=false;s.composer.render();const original=read();
      pass.prepassEnabled=true;s.composer.render();pixels.push({scenario,...compare(original,read())});
    }
    const finite=s.getStats().modelPosition.every(Number.isFinite)&&s.getStats().modelPosition.every(v=>Math.abs(v)<10000);
    return {rows,pixels,aoPixels,originalAoPixels,finite,quality:JSON.parse(document.querySelector('#three-scene').dataset.renderQuality),graphics:s.getStats().graphics,error:gl.getError(),disjoint:gl.getParameter(ext.GPU_DISJOINT_EXT)};
  });
  assert.equal(result.error,0); assert.equal(result.disjoint,false); assert.deepEqual(errors,[]);
  assert.equal(result.finite,true); for(const p of result.pixels)assert.ok(p.mean<.01,JSON.stringify(p));
  for(const p of result.aoPixels)assert.equal(p.max,0,JSON.stringify(p));
  for(const p of result.originalAoPixels)assert.equal(p.max,0,JSON.stringify(p));
  await page.screenshot({path:`${root}/${label}.png`});
  await writeFile(`${root}/${label}.json`,JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify({rows:result.rows.map(({stats,...r})=>({...r,drawCalls:stats.drawCalls,triangles:stats.triangles,covers:stats.covers})),pixels:result.pixels,aoPixels:result.aoPixels,originalAoPixels:result.originalAoPixels,quality:result.quality,graphics:result.graphics},null,2));
} finally { await browser.close(); }
