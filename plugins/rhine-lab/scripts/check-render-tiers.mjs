import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE || "playwright"
);
const base = process.env.RHINE_TEST_URL || "http://127.0.0.1:5322";
const label = process.env.RHINE_CAPTURE || "after";
const evidence = ".cache/render-tiers";
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--use-angle=d3d11", "--disable-backgrounding-occluded-windows"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
const requests = [];
page.on("pageerror", (e) => errors.push(String(e.stack)));
page.on("request", (r) => {
  if (/demo-covers|cooked/.test(r.url())) requests.push(r.url());
});
await page.route(base + "/__tiers", (route) =>
  route.fulfill({
    contentType: "text/html",
    body: `
<style>html,body,#stage,#three-scene{margin:0;width:100%;height:100%;overflow:hidden}</style>
<main id="stage"><div id="three-scene"></div></main><script type="module">
import { ArchiveScene } from '/src/scene.ts';
import { setMusicAlbums } from '/src/data.ts';
import { demoAlbums, demoGenres } from '/src/demo-library.ts';
import { qualityPresets } from '/src/render-quality.ts';
setMusicAlbums(Array.from({length:1000},(_,i)=>({...demoAlbums[i%3],id:'test-'+i,title:'Archive '+i})), demoGenres);
const scene = new ArchiveScene(document.querySelector('#three-scene')); scene.enableSelectionLighting();
await scene.load(); scene.setQuality(qualityPresets.original); scene.setReduced(true);
await scene.prepareMusicRenderer(); scene.showMusicArchiveImmediately(100);
window.testScene = scene;
</script>`,
  }),
);
try {
  await page.goto(base + "/__tiers");
  await page.waitForFunction(() => window.testScene, undefined, {
    timeout: 120000,
  });
  const results = [];
  for (const theme of ["day", "night"]) {
    const result = await page.evaluate(async (theme) => {
      const s = window.testScene;
      s.setTheme(theme);
      for (let i = 0; i < 240; i++) s.update(110 + i / 60, undefined, false);
      await s.covers.prepareVisible(3000);
      for (let i = 0; i < 12; i++) s.covers.flushUploads(s.renderer, 64);
      for (let i = 0; i < 4; i++) s.update(120);
      const gl = s.renderer.getContext(),
        ext = gl.getExtension("EXT_disjoint_timer_query_webgl2");
      const queries = [],
        cpu = [];
      for (let i = 0; i < 24; i++) {
        const q = ext && gl.createQuery();
        if (q) gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
        const start = performance.now();
        s.update(120);
        cpu.push(performance.now() - start);
        if (q) {
          gl.endQuery(ext.TIME_ELAPSED_EXT);
          queries.push(q);
        }
        await new Promise(requestAnimationFrame);
      }
      gl.finish();
      const gpu = queries
        .filter((q) => gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE))
        .map((q) => gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6)
        .sort((a, b) => a - b);
      queries.forEach((q) => gl.deleteQuery(q));
      cpu.sort((a, b) => a - b);
      return {
        theme,
        drawCalls: s.renderer.info.render.calls,
        triangles: s.renderer.info.render.triangles,
        cpuMedian: cpu[Math.floor(cpu.length / 2)],
        gpuMedian: gpu[Math.floor(gpu.length / 2)] ?? null,
        disjoint: ext ? gl.getParameter(ext.GPU_DISJOINT_EXT) : null,
        stats: s.getStats(),
        error: gl.getError(),
      };
    }, theme);
    assert.equal(result.error, 0);
    results.push(result);
    await page.screenshot({ path: `${evidence}/${label}-${theme}.png` });
  }
  let validation;
  if (label !== "before") {
    validation = await page.evaluate(async () => {
      const s = window.testScene;
      const { Raycaster, Vector2 } =
        await import("/node_modules/three/build/three.module.js");
      const read = () => {
        const gl = s.renderer.getContext(),
          p = new Uint8Array(
            gl.drawingBufferWidth * gl.drawingBufferHeight * 4,
          );
        gl.readPixels(
          0,
          0,
          gl.drawingBufferWidth,
          gl.drawingBufferHeight,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          p,
        );
        return p;
      };
      const compare = (a, b) => {
        let max = 0,
          sum = 0,
          changed = 0;
        for (let i = 0; i < a.length; i++) {
          const d = Math.abs(a[i] - b[i]);
          max = Math.max(max, d);
          sum += d;
          if (d > 8) changed++;
        }
        return { max, mean: sum / a.length, over8: changed / a.length };
      };
      s.update(120);
      const cached = read(),
        cacheCalls = s.renderer.info.render.calls;
      s.ao.invalidate();
      s.renderer.shadowMap.needsUpdate = true;
      s.update(120);
      const forced = read(),
        forcedCalls = s.renderer.info.render.calls;
      const cachePixels = compare(cached, forced);
      const tierBefore = s.getStats().renderTiers;
      s.setQuality({ ...s.quality, modelDetail: "full" });
      s.update(120);
      s.update(120);
      const full = read();
      const fullCounts = s.getStats().renderTiers;
      s.setQuality({ ...s.quality, modelDetail: "auto" });
      s.update(120);
      s.update(120);
      const proxyPixels = compare(full, read());
      const ray = new Raycaster(),
        cursor = new Vector2();
      let picks = 0,
        matches = 0;
      for (let y = -0.75; y <= 0.75; y += 0.25)
        for (let x = -0.75; x <= 0.75; x += 0.25) {
          cursor.set(x, y);
          ray.setFromCamera(cursor, s.camera);
          const a = ray.intersectObject(s.instances[0], false)[0]?.instanceId;
          const b = ray.intersectObject(s.modelProxies.pick, false)[0]
            ?.instanceId;
          if (a !== undefined) {
            picks++;
            if (a === b) matches++;
          }
        }
      const source = s.instances[0].instanceMatrix.array;
      const expected = new Set();
      for (let i = 0; i < source.length; i += 16)
        if (source[i] || source[i + 5] || source[i + 10])
          expected.add(Array.from(source.slice(i, i + 16)).join(","));
      let compact = 0,
        slotsValid = true;
      for (const tier of s.modelProxies.batches) {
        const batch = tier[0];
        for (let i = 0; i < batch.count; i++) {
          compact++;
          slotsValid &&= expected.has(
            Array.from(
              batch.instanceMatrix.array.slice(i * 16, i * 16 + 16),
            ).join(","),
          );
        }
      }
      s.setMusicOverview(true);
      for (let i = 0; i < 240; i++) s.update(121 + i / 60, undefined, false);
      s.update(125);
      const overview = s.getStats().renderTiers;
      s.setMusicOverview(false);
      s.setMode("detail");
      for (let i = 0; i < 240; i++) s.update(126 + i / 60, undefined, false);
      s.update(130);
      const detail = {
        phase: s.getStats().musicPresentationPhase,
        triangles: s.model.children
          .filter((m) => m.userData.surface)
          .reduce((n, m) => n + m.geometry.index.count / 3, 0),
      };
      s.setMode("archive");
      s.setReduced(false);
      const misses = s.ao.stats.misses;
      for (let i = 0; i < 180; i++) {
        if (i % 20 === 0) s.select((i * 7) % 1000);
        if (i === 90) s.setMusicArrayMode("realistic");
        s.update(131 + i / 60, undefined, i % 10 === 0);
        if (i % 30 === 0) await new Promise((r) => setTimeout(r, 0));
      }
      const motionMisses = s.ao.stats.misses - misses;
      const error = s.renderer.getContext().getError();
      return {
        cachePixels,
        cacheCalls,
        forcedCalls,
        proxyPixels,
        tierBefore,
        fullCounts,
        picks,
        matches,
        compact,
        expected: expected.size,
        slotsValid,
        overview,
        detail,
        motionMisses,
        error,
      };
    });
    assert.equal(
      validation.cachePixels.max <= 1,
      true,
      "Occlusion/shadow reuse agrees with a forced redraw",
    );
    assert.ok(validation.cacheCalls < validation.forcedCalls);
    assert.ok(validation.tierBefore.medium > 0);
    assert.equal(validation.fullCounts.medium, 0);
    assert.equal(validation.fullCounts.far, 0);
    assert.ok(
      validation.proxyPixels.mean < 2,
      JSON.stringify(validation.proxyPixels),
    );
    assert.ok(validation.picks > 10);
    assert.ok(
      validation.matches / validation.picks > 0.95,
      "Proxy picks preserve canonical slot IDs",
    );
    assert.equal(validation.compact, validation.expected);
    assert.ok(validation.slotsValid);
    assert.ok(
      validation.overview.far > 0,
      "Overview actually uses the far tier",
    );
    assert.equal(validation.detail.triangles, 1000);
    assert.ok(validation.motionMisses > 5);
    assert.equal(validation.error, 0);
  }
  assert.deepEqual(errors, []);
  await writeFile(
    `${evidence}/${label}.json`,
    JSON.stringify({ results, validation, requests, errors }, null, 2),
  );
  console.log(
    JSON.stringify(
      results.map(({ stats, ...r }) => ({
        ...r,
        tiers: stats.renderTiers,
        cache: stats.occlusionCache,
      })),
      null,
      2,
    ),
  );
  console.log(JSON.stringify(validation));
} finally {
  await browser.close();
}
