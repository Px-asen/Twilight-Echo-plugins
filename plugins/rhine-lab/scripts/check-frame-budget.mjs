import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE || "playwright"
);
const base = process.env.RHINE_TEST_URL || "http://127.0.0.1:5321";
const evidence = process.env.RHINE_EVIDENCE_DIR || ".cache/frame-budget";
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--use-angle=d3d11", "--disable-backgrounding-occluded-windows"],
});
const page = await browser.newPage({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1.5,
});
const errors = [],
  measurements = [];
page.on("pageerror", (error) => errors.push(String(error.stack)));
page.on("console", (message) => {
  if (message.type() === "error") console.log(message.text().slice(0, 300));
});
page.setDefaultTimeout(45000);
async function ready() {
  await page.locator("#three-scene canvas").waitFor();
  const skip = page.locator(".opening-skip");
  if (await skip.isVisible()) await skip.click();
  await page
    .locator(".rhine-loading")
    .waitFor({ state: "hidden", timeout: 120000 });
  const musicSkip = page.locator(".music-boot-skip");
  if (await musicSkip.isVisible()) await musicSkip.click();
  await page.waitForFunction(
    () => window.rhineMusic?.presentation.archiveReady,
  );
}
async function sample(cap, context = "shelf") {
  // The runtime counter increments only after the actual scene/viewer update.
  // Two reporting windows exclude the previous limit's partial window.
  await page.waitForTimeout(3300);
  const result = {
    cap,
    context,
    fps: Number(
      (await page.locator("#runtime-info").textContent()).match(/(\d+) FPS/)[1],
    ),
  };
  assert.ok(result.fps <= cap + 2, JSON.stringify(result));
  assert.ok(result.fps > Math.min(cap, 60) * 0.65, JSON.stringify(result));
  measurements.push(result);
}
try {
  await page.goto(base + "/?demo=1&lab=0&scene=archive");
  await page.bringToFront();
  await ready();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const fps = page.locator('[data-quality="frameRate"]');
  assert.equal(await fps.inputValue(), "60");
  assert.equal(
    await page.locator('[data-quality="pixelRatio"]').inputValue(),
    "1.5",
  );
  assert.deepEqual(
    await fps
      .locator("option")
      .evaluateAll((nodes) => nodes.map((node) => node.value)),
    ["24", "30", "60", "120"],
  );
  for (const cap of [24, 30, 60, 120]) {
    await fps.selectOption(String(cap));
    await sample(cap);
  }
  await fps.selectOption("30");
  await page.locator("#quality-preset").selectOption("high");
  assert.equal(
    await fps.inputValue(),
    "30",
    "Preset changes must retain the independent FPS setting",
  );
  await page.locator("#quality-preset").selectOption("original");
  await page.screenshot({ path: evidence + "/settings.png" });
  await page.reload();
  await ready();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  assert.equal(await fps.inputValue(), "30", "FPS is restored after reload");
  assert.equal(
    await page.locator('[data-quality="pixelRatio"]').inputValue(),
    "1.5",
  );
  await page.locator('[data-action="close-panel"]').click();
  await page.route(base + "/__shadow-cache", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `
<!doctype html><style>html,body,#stage,#three-scene{margin:0;width:100%;height:100%;overflow:hidden}</style>
<main id="stage"><div id="three-scene"></div></main><script type="module">
import { ArchiveScene } from '/src/scene.ts';
import { setMusicAlbums } from '/src/data.ts';
import { demoAlbums, demoGenres } from '/src/demo-library.ts';
import { qualityPresets } from '/src/render-quality.ts';
setMusicAlbums(demoAlbums, demoGenres);
const scene = new ArchiveScene(document.querySelector('#three-scene'));
scene.enableSelectionLighting();
await scene.load(); scene.setQuality(qualityPresets.original); scene.setReduced(true);
await scene.prepareMusicRenderer(); scene.showMusicArchiveImmediately(100);
window.testScene=scene;
</script>`,
    }),
  );
  await page.goto(base + "/__shadow-cache");
  await page.waitForFunction(() => window.testScene, undefined, {
    timeout: 120000,
  });
  // Compare cached shadows with a forced refresh at the same scene state.
  const shadow = await page.evaluate(async () => {
    const scene = window.testScene;
    scene.setReduced(true);
    for (let i = 0; i < 180; i++) scene.update(100 + i / 60, undefined, false);
    const read = () => {
      const gl = scene.renderer.getContext();
      const pixels = new Uint8Array(
        gl.drawingBufferWidth * gl.drawingBufferHeight * 4,
      );
      gl.readPixels(
        0,
        0,
        gl.drawingBufferWidth,
        gl.drawingBufferHeight,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        pixels,
      );
      return pixels;
    };
    scene.update(104);
    scene.renderer.info.reset();
    scene.composer.render();
    const cachedCalls = scene.renderer.info.render.calls,
      cached = read();
    scene.renderer.shadowMap.needsUpdate = true;
    scene.renderer.info.reset();
    scene.composer.render();
    const forcedCalls = scene.renderer.info.render.calls,
      forced = read();
    let maximum = 0;
    for (let i = 0; i < cached.length; i++)
      maximum = Math.max(maximum, Math.abs(cached[i] - forced[i]));
    return {
      cachedCalls,
      forcedCalls,
      maximum,
      error: scene.renderer.getContext().getError(),
    };
  });
  assert.equal(shadow.error, 0);
  assert.ok(
    shadow.maximum <= 1,
    "Cached shadows stay within one 8-bit rounding step of a forced refresh",
  );
  assert.ok(
    shadow.cachedCalls < shadow.forcedCalls,
    "Cached scene skips a real shadow draw",
  );
  assert.deepEqual(errors, []);
  await writeFile(
    evidence + "/result.json",
    JSON.stringify({ measurements, shadow, errors }, null, 2),
  );
  console.log(JSON.stringify({ measurements, shadow, evidence }));
} catch (error) {
  console.log(
    JSON.stringify({
      errors,
      status: (await page.locator(".opening-status").count())
        ? await page.locator(".opening-status").textContent()
        : null,
      graphics: await page.evaluate(() => ({
        hidden: document.hidden,
        stats: window.rhineMusic?.stats(),
      })),
    }),
  );
  await page.screenshot({ path: evidence + "/failure.png" });
  throw error;
} finally {
  await browser.close();
}
