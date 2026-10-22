import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const base=process.env.RHINE_TEST_URL||'http://127.0.0.1:5322';
const browser=await chromium.launch({channel:'msedge',headless:true,args:['--use-angle=d3d11']});
const page=await browser.newPage();const errors=[];
page.on('pageerror',e=>errors.push(String(e.stack)));
await page.route(base+'/@vite/client',r=>r.fulfill({contentType:'text/javascript',body:''}));
await page.route(base+'/__memory-aa',r=>r.fulfill({contentType:'text/html',body:'<main></main>'}));
try {
  await page.goto(base+'/__memory-aa');
  const result=await page.evaluate(async()=>{
    const T=await import('/node_modules/three/build/three.module.js');
    const {CoverAtlas}=await import('/src/cover-atlas.ts');
    const {LightAntialiasPass}=await import('/src/antialias-pass.ts');
    const {FullScreenQuad}=await import('/node_modules/three/examples/jsm/postprocessing/Pass.js');
    const renderer=new T.WebGLRenderer({antialias:false,preserveDrawingBuffer:true});
    renderer.setPixelRatio(1);renderer.setSize(512,256);renderer.autoClear=false;
    const atlas=new CoverAtlas(612,8192,16),initial=atlas.getStats();
    const canvas=document.createElement('canvas');canvas.width=canvas.height=16;
    canvas.getContext('2d').fillStyle='#ff0000';canvas.getContext('2d').fillRect(0,0,16,16);
    const image={source:canvas,width:16,height:16,decodedSize:256,pixels:256};
    atlas.loadImage=async()=>image;atlas.cachedImage=()=>image;
    for(let i=0;i<210;i++)atlas.setSlot(i,{id:'print-'+i,title:'Print '+i,album:{coverUrl:'solid'}});
    const grown=atlas.getStats();while(atlas.getStats().dirtyTiles)atlas.flushUploads(renderer,64);
    const firstPixel=atlas.atlasCanvas.getContext('2d').getImageData(128,128,1,1).data;
    // Sample an old and a new resident tile from the GPU after growth. This
    // detects both lost canvas pixels and incorrect flipped UVs/storage size.
    const target=new T.WebGLRenderTarget(1,1,{depthBuffer:false});
    const sample=new T.ShaderMaterial({uniforms:{map:{value:atlas.array.material.map},point:{value:new T.Vector2()}},
      vertexShader:'void main(){gl_Position=vec4(position,1.0);}',
      fragmentShader:'uniform sampler2D map;uniform vec2 point;void main(){gl_FragColor=texture2D(map,point);}',depthTest:false,depthWrite:false});
    const quad=new FullScreenQuad(sample),gpuTiles=[];
    const uv=atlas.array.geometry.attributes.coverTile;
    for(const slot of [0,191,209]){
      sample.uniforms.point.value.set(uv.getX(slot)+uv.getZ(slot)*.5,uv.getY(slot)+uv.getW(slot)*.5);
      renderer.setRenderTarget(target);quad.render(renderer);const pixel=new Uint8Array(4);
      renderer.readRenderTargetPixels(target,0,0,1,1,pixel);gpuTiles.push([...pixel]);
    }
    for(let i=0;i<1000;i++)atlas.setSlot(0,{id:'recycle-'+i,title:'Recycle',album:{coverUrl:'solid'}});
    const recycled=atlas.getStats();atlas.reset();const reset=atlas.getStats();atlas.dispose();
    target.dispose();sample.dispose();quad.dispose();
    const width=512,height=256;
    const input=new T.WebGLRenderTarget(width,height,{depthBuffer:false});
    const edge=new T.ShaderMaterial({vertexShader:'varying vec2 vUv;void main(){vUv=uv;gl_Position=vec4(position,1.0);}',
      fragmentShader:'varying vec2 vUv;void main(){gl_FragColor=vec4(vec3(step(0.0,vUv.y-.123-.57*vUv.x)),1.0);}',depthTest:false,depthWrite:false});
    const edgeQuad=new FullScreenQuad(edge);renderer.setRenderTarget(input);edgeQuad.render(renderer);
    const raw=new Uint8Array(width*height*4);renderer.readRenderTargetPixels(input,0,0,width,height,raw);
    const aa=new LightAntialiasPass();aa.setSize(width,height);aa.renderToScreen=true;aa.render(renderer,input,input,0,false);
    const smoothed=new Uint8Array(raw.length),gl=renderer.getContext();gl.readPixels(0,0,width,height,gl.RGBA,gl.UNSIGNED_BYTE,smoothed);
    let rawError=0,aaError=0,edges=0,flatChanges=0;
    for(let y=0;y<height;y++)for(let x=0;x<width;x++){
      const distance=(y+.5)/height-.123-.57*(x+.5)/width;
      const index=(y*width+x)*4;
      if(Math.abs(distance)<2/height){
        let coverage=0;for(let sy=0;sy<8;sy++)for(let sx=0;sx<8;sx++)
          if((y+(sy+.5)/8)/height-.123-.57*(x+(sx+.5)/8)/width>=0)coverage++;
        const reference=coverage*255/64;rawError+=Math.abs(raw[index]-reference);aaError+=Math.abs(smoothed[index]-reference);edges++;
      } else if(Math.abs(raw[index]-smoothed[index])>1)flatChanges++;
    }
    aa.dispose();input.dispose();edge.dispose();edgeQuad.dispose();
    const error=gl.getError();renderer.dispose();renderer.forceContextLoss();
    return{initial,grown,recycled,reset,firstPixel:[...firstPixel],gpuTiles,aa:{rawError:rawError/edges,aaError:aaError/edges,edges,flatChanges},error};
  });
  assert.equal(result.error,0);assert.deepEqual(errors,[]);
  assert.equal(result.initial.atlasBytes,48*1024**2);assert.equal(result.grown.atlasCapacity,384);
  assert.equal(result.recycled.atlasCapacity,384);assert.equal(result.reset.atlasBytes,result.initial.atlasBytes);
  assert.deepEqual(result.firstPixel,[255,0,0,255]);result.gpuTiles.forEach(p=>assert.deepEqual(p,[255,0,0,255]));
  assert.ok(result.aa.aaError<result.aa.rawError*.8,JSON.stringify(result.aa));assert.equal(result.aa.flatChanges,0);
  await mkdir('.cache/gpu-cost',{recursive:true});await writeFile('.cache/gpu-cost/memory-aa-validation.json',JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify(result,null,2));
} finally {await browser.close();}
