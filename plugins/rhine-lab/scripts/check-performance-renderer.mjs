import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const output = resolve('.cache/performance-renderer-' + Date.now());
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
const errors = [];
page.on('pageerror', error => { errors.push(error.stack); console.error(error.stack); });
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
const base = process.env.RHINE_TEST_URL || 'http://127.0.0.1:5321';
await page.route(base + '/__performance-review', route => route.fulfill({ contentType: 'text/html', body: `
<!doctype html><meta charset="utf-8"><style>html,body,#stage,#three-scene{margin:0;width:100%;height:100%;overflow:hidden}canvas{display:block}</style>
<main id="stage"><div id="three-scene"></div></main><script type="module">
import * as THREE from '/node_modules/three/build/three.module.js';
import { ArchiveScene } from '/src/scene.ts';
import { setMusicAlbums, records, fileAtSlot } from '/src/data.ts';
import { fileAtCell } from '/src/archive-loop.ts';
import { demoAlbums, demoGenres } from '/src/demo-library.ts';
import { qualityPresets } from '/src/render-quality.ts';
import { CoverAtlas } from '/src/cover-atlas.ts';
setMusicAlbums(demoAlbums, demoGenres);
const scene = new ArchiveScene(document.querySelector('#three-scene'));
scene.enableSelectionLighting();
await scene.load(); scene.setQuality(qualityPresets.original);
await scene.prepareMusicRenderer(); scene.showMusicArchiveImmediately(100);
window.review = { THREE, scene, qualityPresets, CoverAtlas, records, fileAtSlot, fileAtCell };
</script>` }));
try {
  await page.goto(base + '/__performance-review');
  await page.waitForFunction(() => window.review, undefined, { timeout: 120000 });
  const visual = [];
  for(const [width,height] of (process.env.RHINE_RENDERER_QUICK ? [[1366,768]] : [[1366,768],[1920,1080],[900,1200]])) {
  await page.setViewportSize({width,height});
  await page.evaluate(()=>window.review.scene.resize());
  for (const theme of (process.env.RHINE_RENDERER_QUICK ? ['day'] : ['day', 'night', 'dusk'])) for (const mode of (process.env.RHINE_RENDERER_QUICK ? ['archive'] : ['archive', 'detail', 'overview'])) {
    const result = await page.evaluate(({ theme, mode }) => {
      const { scene } = window.review;
      scene.setTheme(theme); scene.setMusicOverview(mode === 'overview');
      scene.setMode(mode === 'detail' ? 'detail' : 'archive');
      for (let i = 0; i < 200; i++) scene.update(101 + i / 60, undefined, false);
      while (scene.covers.getStats().dirtyTiles) scene.covers.flushUploads(scene.renderer, 64);
      const source = scene.bokeh.source;
      const capture = shared => {
        scene.bokeh.source = shared ? source : () => undefined;
        scene.renderer.shadowMap.needsUpdate = true;
        scene.renderer.info.reset(); scene.composer.render();
        const gl = scene.renderer.getContext(), pixels = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4);
        gl.readPixels(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        return { pixels, png: scene.renderer.domElement.toDataURL(), calls: scene.renderer.info.render.calls, triangles: scene.renderer.info.render.triangles, shared: scene.bokeh.sharedDepth, error: gl.getError() };
      };
      capture(false); const original = capture(false); capture(true); const shared = capture(true);
      scene.bokeh.source = source;
      let total = 0, maximum = 0, changed = 0, over8 = 0;
      for (let i = 0; i < shared.pixels.length; i += 4) {
        let delta = 0;
        for (let c = 0; c < 3; c++) { const d = Math.abs(shared.pixels[i+c] - original.pixels[i+c]); total += d; maximum = Math.max(maximum, d); delta = Math.max(delta,d); }
        if(delta) changed++; if(delta > 8) over8++;
      }
      const pixels = shared.pixels.length / 4;
      const { pixels: _, ...a } = original, { pixels: __, ...b } = shared;
      return { theme, mode, meanChannelDelta: total / (pixels * 3), maxChannelDelta: maximum, changedPixels: changed / pixels, over8Pixels: over8 / pixels, original: a, optimized: b };
    }, { theme, mode });
    assert.equal(result.optimized.shared, true); assert.equal(result.original.error, 0); assert.equal(result.optimized.error, 0);
    assert.ok(result.meanChannelDelta<2 && result.over8Pixels<.03,'Shared depth should preserve the original image');
    result.width=width;result.height=height;
    for(const [name,data] of [['original',result.original],['optimized',result.optimized]]) {
      await writeFile(join(output, `${width}x${height}-${theme}-${mode}-${name}.png`), Buffer.from(data.png.split(',')[1], 'base64')); delete data.png;
    }
    visual.push(result); console.log(JSON.stringify(result));
  }
  }
  const fallback = await page.evaluate(() => {
    const { scene, qualityPresets } = window.review, cases = [];
    for (const [aoSamples, aoResolution,scale=100] of [[32,.5],[32,.75],[0,1],[64,1],[32,1],[32,1,125],[32,1,150]]) {
      scene.setQuality({ ...qualityPresets.original, aoSamples, aoResolution,scale }); scene.update(110);
      cases.push({ aoSamples, aoResolution,scale,shared: scene.bokeh.sharedDepth, error: scene.renderer.getContext().getError() });
    }
    scene.setQuality(qualityPresets.original);
    return cases;
  });
  for(const c of fallback) { assert.equal(c.shared, c.aoSamples > 0 && c.aoResolution === 1); assert.equal(c.error,0); }
  // Compare actual GPU pixels against CPU atlas tiles, including alpha, sparse
  // updates, row ends, stale-slot suppression and the existing byte budget.
  const atlas = await page.evaluate(async () => {
    const { THREE, scene, CoverAtlas, records } = window.review;
    const atlas = new CoverAtlas(48, 4096, 1), renderer = scene.renderer;
    const gl=renderer.getContext(),calls = [],copy=gl.texSubImage2D;
    gl.texSubImage2D=function(...args){if(args[8]===atlas.uploadCanvas)calls.push({width:args[4],height:args[5],x:args[2],y:args[3]});return copy.apply(this,args);};
    const target = new THREE.WebGLRenderTarget(atlas.atlasCanvas.width, atlas.atlasCanvas.height);
    const camera = new THREE.Camera(), quadScene = new THREE.Scene();
    const material = new THREE.MeshBasicMaterial({ map: atlas.atlas, toneMapped: false });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2,2), material); quadScene.add(quad);
    const checks = [];
    const read = () => {
      renderer.setRenderTarget(target); renderer.render(quadScene,camera);
      const pixels = new Uint8Array(target.width * target.height * 4); renderer.readRenderTargetPixels(target,0,0,target.width,target.height,pixels); return pixels;
    };
    try {
      for(let i=0;i<48;i++) atlas.setSlot(i,{...records[i % records.length],id:'unique-'+i,title:'Cover '+i});
      await atlas.prepareVisible(3000);
      while(atlas.getStats().dirtyTiles) atlas.flushUploads(renderer,8);
      const unpack=[gl.UNPACK_ROW_LENGTH,gl.UNPACK_IMAGE_HEIGHT,gl.UNPACK_SKIP_PIXELS,gl.UNPACK_SKIP_ROWS,gl.UNPACK_SKIP_IMAGES,gl.UNPACK_FLIP_Y_WEBGL,gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL,gl.UNPACK_ALIGNMENT];
      const previous=unpack.map(p=>gl.getParameter(p)),custom=[7,9,1,2,3,true,true,8];
      atlas.setSlot(0,{...records[0],id:'state-check'});
      unpack.forEach((p,i)=>gl.pixelStorei(p,custom[i]));
      const getParameter=gl.getParameter;let reads=0;
      gl.getParameter=function(parameter){if(unpack.includes(parameter))reads++;return getParameter.call(this,parameter);};
      atlas.flushUploads(renderer,8);
      gl.getParameter=getParameter;
      if(reads)throw Error('A warmed upload synchronously queried GPU unpack state');
      if(unpack.some((p,i)=>gl.getParameter(p)!==custom[i]))throw Error('Atlas upload leaked WebGL unpack state');
      unpack.forEach((p,i)=>gl.pixelStorei(p,previous[i]));
      checks.push({unpackRestored:true,warmedUploadStateReads:reads,maxPixelDelta:0});
      let region=0;
      for(const dirty of [[1,2,3,7],[15,16,17],[0,8,23,39,47]]) {
        for(const i of dirty) atlas.setSlot(i,{...records[(i+1)%records.length],id:'region-'+region+'-'+i,title:'Region '+region+'-'+i});
        region++;
        const before=atlas.getStats().uploadedBytes, first=calls.length;
        atlas.flushUploads(renderer,8);
        const bytes=atlas.getStats().uploadedBytes-before;
        if(bytes>8*atlas.tileWidth*atlas.tileHeight*4) throw Error('Upload budget exceeded');
        while(atlas.getStats().dirtyTiles) atlas.flushUploads(renderer,8);
        // The shader samples a linearized sRGB texture into the linear target;
        // compare via an independently uploaded complete canvas reference.
        const actual=read(), reference=new THREE.CanvasTexture(atlas.atlasCanvas);
        reference.colorSpace=THREE.SRGBColorSpace; reference.generateMipmaps=false; reference.minFilter=THREE.LinearFilter;
        material.map=reference; const expected=read(); material.map=atlas.atlas;
        let max=0; for(let i=0;i<actual.length;i++) max=Math.max(max,Math.abs(actual[i]-expected[i]));
        reference.dispose();
        checks.push({dirty,bytes,calls:calls.slice(first),maxPixelDelta:max});
      }
      // An unknown Three revision/texture handle uses the public API instead.
      const fallbackRenderer=Object.create(renderer);
      Object.defineProperty(fallbackRenderer,'properties',{value:{get:()=>({})}});
      atlas.setSlot(14,{...records[0],id:'public-api-fallback'});
      atlas.flushUploads(fallbackRenderer,8);
      const actual=read(),reference=new THREE.CanvasTexture(atlas.atlasCanvas);
      reference.colorSpace=THREE.SRGBColorSpace;reference.generateMipmaps=false;reference.minFilter=THREE.LinearFilter;
      material.map=reference;const expected=read();material.map=atlas.atlas;reference.dispose();
      let fallbackDelta=0;for(let i=0;i<actual.length;i++)fallbackDelta=Math.max(fallbackDelta,Math.abs(actual[i]-expected[i]));
      checks.push({publicApiFallback:true,maxPixelDelta:fallbackDelta});
      const beforeReuse=atlas.getStats().uploadCalls;
      for(let i=0;i<48;i++) atlas.setSlot(i,records[(i+1)%records.length]);
      while(atlas.getStats().dirtyTiles) atlas.flushUploads(renderer,8);
      const warmed=atlas.getStats().uploadCalls;
      for(let i=0;i<48;i++) atlas.setSlot(i,records[(i+2)%records.length]);
      atlas.flushUploads(renderer,8);
      if(atlas.getStats().uploadCalls!==warmed) throw Error('Resident prints uploaded again');
      // Force repeated physical-tile eviction while older decodes can finish.
      for(let i=0;i<100;i++) atlas.setSlot(i%48,{...records[i%records.length],id:'evict-'+i,title:'Replacement '+i});
      await atlas.prepareVisible(3000);
      while(atlas.getStats().dirtyTiles) atlas.flushUploads(renderer,8);
      for(let i=0;i<48;i++) {
        const tile=atlas.slotTiles[i], u=atlas.coverTiles.getX(i),v=atlas.coverTiles.getY(i);
        if(atlas.tileKeys[tile]!==atlas.slotKeys[i] || atlas.coverReady.getX(i)!==1 ||
          Math.abs(u-(tile%atlas.columns)/atlas.columns)>1e-6 ||
          Math.abs(v-(1-(Math.floor(tile/atlas.columns)+1)/atlas.rows))>1e-6) throw Error('Resident print ownership/UV mismatch');
      }
      checks.push({residentReuse:true,uploadCallsBefore:beforeReuse,uploadCallsAfterWarm:warmed,capacity:atlas.keyTiles.size,maxPixelDelta:0});
      atlas.reset();
      for(let i=0;i<48;i++) if(atlas.coverReady.getX(i)!==0)throw Error('Reset left a stale visible print');
    } finally { gl.texSubImage2D=copy; renderer.setRenderTarget(null); atlas.dispose(); target.dispose(); material.dispose(); quad.geometry.dispose(); }
    return checks;
  });
  for(const c of atlas) assert.equal(c.maxPixelDelta,0,'Batched uploads match the complete canvas');
  const pointer = await page.evaluate(async () => {
    const { scene }=window.review;
    scene.setMusicOverview(false);scene.setMode('archive');
    for(let i=0;i<200;i++)scene.update(115+i/60);
    const canvas=scene.renderer.domElement,rect=canvas.getBoundingClientRect();
    const intersect=scene.raycaster.intersectObjects;let calls=0,hover;
    scene.raycaster.intersectObjects=function(...args){calls++;return intersect.apply(this,args);};
    scene.onHover=value=>{hover=value;};
    try {
      for(let i=0;i<512;i++)canvas.dispatchEvent(new PointerEvent('pointermove',{clientX:rect.left+rect.width*(.3+i/2000),clientY:rect.top+rect.height*.5,pointerType:'mouse',pointerId:1}));
      const immediate=calls;
      await new Promise(requestAnimationFrame);
      const coalesced=calls;
      scene.raycaster.setFromCamera(scene.cursor,scene.camera);
      const hit=intersect.call(scene.raycaster,[scene.instances[0],scene.model],true).find(hit=>scene.pickableCell(hit.instanceId===undefined?scene.selectedCell:scene.cells[hit.instanceId]));
      // Existing callback reports the album ID through the same logical cell.
      const expected=hit?hit.instanceId===undefined?window.review.fileAtSlot(scene.selectedSlot):
        window.review.fileAtCell(scene.cells[hit.instanceId]):null;
      if(hover!==expected)throw Error('Coalescing changed the selected hover album');
      canvas.dispatchEvent(new PointerEvent('pointermove',{clientX:rect.left+10,clientY:rect.top+10,pointerType:'mouse',pointerId:1}));
      canvas.dispatchEvent(new PointerEvent('pointerleave',{pointerType:'mouse',pointerId:1}));
      await new Promise(requestAnimationFrame);
      if(immediate!==0||coalesced!==1||calls!==1||hover!==null)throw Error('Hover coalescing/leave cancellation failed');
      return {events:512,immediateRaycasts:immediate,raycastsPerFrame:coalesced,leaveCancelled:true};
    }finally{scene.raycaster.intersectObjects=intersect;scene.onHover=undefined;}
  });
  assert.deepEqual(errors, []);
  const disposal = await page.evaluate(()=>{
    const {scene}=window.review;
    scene.renderer.domElement.dispatchEvent(new PointerEvent('pointermove',{pointerType:'mouse',clientX:10,clientY:10}));
    scene.dispose(); scene.dispose();
    return {canvases:document.querySelectorAll('canvas').length,hoverFrame:scene.hoverFrame,contextLost:scene.renderer.getContext().isContextLost()};
  });
  assert.equal(disposal.canvases,0);assert.equal(disposal.hoverFrame,0);assert.equal(disposal.contextLost,true);
  await writeFile(join(output,'result.json'),JSON.stringify({passed:true,visual,fallback,atlas,pointer,disposal,errors},null,2));
  console.log('RENDERER_RESULT '+join(output,'result.json'));
} finally { await browser.close(); }
