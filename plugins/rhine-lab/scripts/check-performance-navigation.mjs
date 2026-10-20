import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.RHINE_TEST_URL || 'http://127.0.0.1:5321';
const output = resolve(process.env.NAVIGATION_EVIDENCE || '.cache/performance-navigation-' + Date.now());
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const errors = [], runs = [];
try {
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 }, deviceScaleFactor: 1.5 });
  page.on('pageerror', error => errors.push(String(error)));
  await page.route(base + '/__navigation-check', route => route.fulfill({ contentType: 'text/html', body: `
    <!doctype html><meta charset="utf-8"><style>html,body,#stage,#three-scene{margin:0;width:100%;height:100%;overflow:hidden}canvas{display:block}</style>
    <main id="stage" data-layout="desktop"><div id="three-scene"></div></main>
    <script type="module">
      import * as THREE from '/node_modules/three/build/three.module.js';
      import { qualityPresets } from '/src/render-quality.ts';
      window.review = { THREE, qualityPresets };
    </script>` }));
  await page.goto(base + '/__navigation-check');
  await page.waitForFunction(() => window.review);
  for (const arrayMode of ['filled', 'realistic']) for (const theme of ['day', 'night']) {
    const results = [];
    for (const variant of ['before', 'after']) {
      const result = await page.evaluate(async ({ variant, arrayMode, theme }) => {
        const root = variant === 'before' ? '/.cache/perf-next-baseline/src' : '/src';
        const [{ ArchiveScene }, data, loop] = await Promise.all([
          import(root + '/scene.ts'), import(root + '/data.ts'), import(root + '/archive-loop.ts'),
        ]);
        const { THREE, qualityPresets } = window.review;
        const genres = Array.from({ length: 12 }, (_, i) => ({ id: 'g' + i, name: 'Genre ' + i }));
        const albums = Array.from({ length: 1000 }, (_, i) => ({
          id: 'a' + i, title: 'Album ' + i, artist: 'Artist ' + (i % 12),
          genreId: genres[i % 12].id, rawGenres: [], folder: '', tracks: [], producers: [], offline: false,
          coverUrl: '/demo-covers/' + ['square', 'portrait', 'landscape'][i % 3] + '.png',
        }));
        data.setMusicAlbums(albums, genres);
        const random = Math.random; let seed = 3125;
        Math.random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
        const scene = new ArchiveScene(document.querySelector('#three-scene'));
        Math.random = random;
        scene.setMusicArrayMode(arrayMode); scene.enableSelectionLighting();
        await scene.load(); scene.setQuality(qualityPresets.original); scene.setTheme(theme);
        await scene.prepareMusicRenderer(); scene.showMusicArchiveImmediately(100);
        const initialCells = [...scene.cells];
        let prepares = 0, snapshots = 0;
        const prepare = scene.appearance.prepare.bind(scene.appearance);
        scene.appearance.prepare = group => { prepares++; return prepare(group); };
        const materials = new Set(), textures = new Set();
        const snapshot = scene.covers.snapshot.bind(scene.covers);
        scene.covers.snapshot = mesh => { snapshots++; snapshot(mesh); materials.add(mesh.material); textures.add(mesh.material.map); };
        const samples = [], states = [], images = [];
        const capture = frame => {
          scene.renderer.info.reset(); scene.renderer.shadowMap.needsUpdate = true;
          scene.covers.flushUploads(scene.renderer, 64); scene.composer.render();
          const gl = scene.renderer.getContext();
          const pixels = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4);
          gl.readPixels(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
          const chunks = [];
          for (let offset = 0; offset < pixels.length; offset += 0x8000)
            chunks.push(String.fromCharCode(...pixels.subarray(offset, offset + 0x8000)));
          const result = { frame, pixels: btoa(chunks.join('')), png: scene.renderer.domElement.toDataURL(),
            calls: scene.renderer.info.render.calls, triangles: scene.renderer.info.render.triangles, error: gl.getError() };
          return result;
        };
        for (let frame = 0; frame < 900; frame++) {
          if (frame === 360) scene.setMusicOverview(true);
          if (frame === 540) scene.setMusicOverview(false);
          if (frame === 680) scene.setMode('detail');
          if (frame === 800) scene.setMode('archive');
          if (frame % 10 === 0 && frame < 660) {
            const lane = frame < 300 ? 2 : 2 + Math.floor(frame / 60) % 4;
            const row = 12 + (Math.floor(frame / 10) % 8);
            scene.select(loop.fileAtCell({ lane, row }), { cell: { lane, row } });
          }
          const start = performance.now();
          scene.update(100 + (frame + 1) / 60, undefined, false);
          samples.push(performance.now() - start);
          if (frame % 15 === 0) states.push({ frame,
            matrices: Array.from(scene.instances[0].instanceMatrix.array),
            model: [...scene.model.position.toArray(), ...scene.model.quaternion.toArray(), ...scene.model.scale.toArray()],
            camera: [...scene.camera.position.toArray(), ...scene.camera.quaternion.toArray(), scene.camera.fov],
            copies: scene.outgoing.map(o => ({ cell: o.cell, position: o.group.position.toArray(), rotation: o.group.quaternion.toArray(), scale: o.group.scale.toArray(), lift: o.lift })),
          });
          // Let queued cover upgrades complete at identical simulation boundaries.
          if (frame % 60 === 0) await new Promise(resolve => setTimeout(resolve, 0));
          if ([299, 599, 779, 899].includes(frame)) images.push(capture(frame));
        }
        const steady = samples.slice(120).sort((a, b) => a - b);
        const result = { variant, arrayMode, theme,
          cpuMean: steady.reduce((a, b) => a + b, 0) / steady.length,
          cpuP95: steady[Math.floor(steady.length * .95)], cpuMax: steady.at(-1),
          prepares, snapshots, materials: materials.size, textures: textures.size,
          stableCells: scene.cells.filter((cell, i) => cell === initialCells[i]).length,
          poolSize: scene.copyPool?.length ?? 0, liveCopies: scene.outgoing.length, states, images,
          quality: JSON.parse(document.querySelector('#three-scene').dataset.renderQuality),
          gpu: scene.renderer.getContext().getParameter(scene.renderer.getContext().getExtension('WEBGL_debug_renderer_info').UNMASKED_RENDERER_WEBGL),
        };
        scene.dispose();
        result.canvasesAfterDispose = document.querySelectorAll('canvas').length;
        return result;
      }, { variant, arrayMode, theme });
      results.push(result);
    }
    const [before, after] = results;
    assert.deepEqual(after.states, before.states, 'Every sampled shell/camera/copy transform preserves the original motion');
    assert.deepEqual(after.quality, before.quality, 'Resolution and all quality settings stay unchanged');
    assert.equal(after.canvasesAfterDispose, 0);
    assert.equal(after.stableCells, 612);
    assert.ok(after.prepares < before.prepares, 'Recycled returns reuse their shell materials');
    assert.ok(after.textures < before.textures, 'Recycled returns reuse their cover texture');
    const visual = [];
    for (let i = 0; i < before.images.length; i++) {
      const a = before.images[i], b = after.images[i];
      const aPixels = Buffer.from(a.pixels, 'base64'), bPixels = Buffer.from(b.pixels, 'base64');
      let sum = 0, max = 0, over8 = 0;
      for (let p = 0; p < aPixels.length; p += 4) {
        let delta = 0;
        for (let c = 0; c < 3; c++) { const d = Math.abs(aPixels[p+c] - bPixels[p+c]); sum += d; max = Math.max(max, d); delta = Math.max(delta, d); }
        if (delta > 8) over8++;
      }
      const comparison = { frame: a.frame, meanChannelDelta: sum / (aPixels.length / 4 * 3), maxChannelDelta: max, over8Pixels: over8 / (aPixels.length / 4), beforeCalls: a.calls, afterCalls: b.calls, beforeTriangles: a.triangles, afterTriangles: b.triangles };
      assert.equal(b.error, 0); assert.equal(a.error, 0);
      assert.equal(b.calls, a.calls); assert.equal(b.triangles, a.triangles);
      assert.ok(comparison.meanChannelDelta < .25 && comparison.over8Pixels < .005, 'Render output preserves the full-quality scene');
      for (const [label, image] of [['before', a], ['after', b]]) await writeFile(join(output, `${arrayMode}-${theme}-${a.frame}-${label}.png`), Buffer.from(image.png.split(',')[1], 'base64'));
      visual.push(comparison);
    }
    for (const result of results) { delete result.states; delete result.images; }
    const run = { arrayMode, theme, before, after, visual };
    runs.push(run); console.log(JSON.stringify(run));
  }
  assert.deepEqual(errors, []);
  await writeFile(join(output, 'result.json'), JSON.stringify({ passed: true, runs, errors, output }, null, 2));
  console.log('NAVIGATION_RESULT ' + output);
} finally { await browser.close(); }
