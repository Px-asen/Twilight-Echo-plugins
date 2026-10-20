import assert from "node:assert/strict";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import ts from "typescript";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const output = resolve(process.env.OPENING_EVIDENCE || ".cache/loading-opening-" + Date.now());
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: process.env.OPENING_BROWSER || "msedge", headless: true });
const errors = [];
const results = [];
const record = value => { results.push(value); console.log(value); };
const base = process.env.OPENING_URL || "http://127.0.0.1:5321";
async function harness(width = 1920, height = 1080) {
  const page = await browser.newPage({ viewport: { width, height } });
  page.on("pageerror", error => errors.push(String(error)));
  await page.clock.install();
  await page.route("**/opening-check", route => route.fulfill({ contentType: "text/html", body: `<!doctype html><meta charset="utf-8"><style>body{margin:0}#viewport{position:fixed;inset:0}</style><main id="viewport"><div id="stage"><button id="under">Underlying action</button></div></main><script type="module">import {loadingOpening} from '/src/loading-opening/index.ts'; window.opening=loadingOpening; window.completed=false;</script>` }));
  await page.goto(base + "/opening-check");
  await page.waitForFunction(() => !!window.opening);
  await page.evaluate(() => document.fonts.ready);
  return page;
}
try {
  async function motionFrom(directory) {
    const sources = new Map();
    for (const name of ["boot-motion", "boot-tracks", "boot-logo-tracks", "boot-orbit-tracks"])
      sources.set("./" + name, await readFile(join(directory, name + ".ts"), "utf8"));
    const cache = new Map();
    function load(name) {
      if (cache.has(name)) return cache.get(name);
      const exports = {};
      cache.set(name, exports);
      const code = ts.transpileModule(sources.get(name), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
      new Function("require", "exports", code)(load, exports);
      return exports;
    }
    return load("./boot-motion").bootMotion;
  }
  const original = await motionFrom(resolve("../../.cache/rhine-lab-ui-source/src"));
  const adapted = await motionFrom(resolve("src/loading-opening"));
  for (let halfFrame = 0; halfFrame <= 1100; halfFrame++) {
    const time = halfFrame / 50;
    const before = original(time), after = adapted(time);
    for (const key of ["access", "auth", "logoLetters", "poweredLetters"]) {
      delete before[key]; delete after[key];
    }
    assert.deepEqual(after, before, `Non-text motion differs at ${time}s`);
  }
  record("1101 half-frame samples: all non-text motion matches the original");
  // The three geometry tracks must retain the exact reference bytes.
  for (const name of ["boot-tracks.ts", "boot-logo-tracks.ts", "boot-orbit-tracks.ts"]) {
    const current = await readFile(resolve("src/loading-opening", name), "utf8");
    const source = await readFile(resolve("../../.cache/rhine-lab-ui-source/src", name), "utf8");
    assert.equal(current.replaceAll("\r\n", "\n"), source.replaceAll("\r\n", "\n"));
  }
  record("original geometry tracks preserved");
  for (const [width, height] of [[1920, 1080], [2100, 900], [900, 1200]]) {
    const page = await harness(width, height);
    assert.equal(await page.locator(".opening-skip").count(), 0);
    await page.evaluate(() => { void window.opening.completeLoading().then(() => window.completed = true); });
    let elapsed = 0;
    for (const [phase, ms] of [["access", 3200], ["logo", 5100], ["application", 9000], ["scan", 15500], ["welcome", 19200]]) {
      await page.clock.runFor(ms - elapsed);
      elapsed = ms;
      assert.equal(await page.locator("#stage").evaluate(node => node.inert), true);
      assert.equal(await page.evaluate(() => window.completed), false);
      assert.equal(await page.locator(".opening-status").textContent(), "");
      if (phase === "application") {
        const center = await page.locator(".boot-logo text").evaluate(node => {
          const bounds = node.getBBox(); return bounds.x + bounds.width / 2;
        });
        assert.ok(Math.abs(center - 155) < 1, `Wordmark center is ${center}`);
      }
      await page.screenshot({ path: join(output, `${width}x${height}-${phase}.png`) });
    }
    await page.clock.runFor(3200);
    assert.equal(await page.evaluate(() => window.completed), true);
    assert.equal(await page.locator("#stage").evaluate(node => node.inert), false);
    assert.equal(await page.locator(".rhine-loading").isHidden(), true);
    // Replay takes the same route and restores the existing input/focus state.
    await page.locator("#under").focus();
    await page.evaluate(() => { window.completed = false; void window.opening.replay(false).then(() => window.completed = true); });
    await page.keyboard.press("Enter");
    assert.equal(await page.evaluate(() => window.completed), true);
    assert.equal(await page.locator("#under").evaluate(node => document.activeElement === node), true);
    record(`${width}x${height}: full timeline, centered wordmark, loading gate, replay and keyboard entry`);
    await page.close();
  }
  {
    const page = await harness();
    await page.clock.runFor(23000);
    assert.equal(await page.locator(".rhine-loading").getAttribute("data-state"), "waiting");
    assert.equal(await page.locator("#stage").evaluate(node => node.inert), true);
    await page.evaluate(() => window.opening.completeLoading());
    assert.equal(await page.locator("#stage").evaluate(node => node.inert), false);
    record("slow resources remain gated after film ends");
    await page.close();
  }
  {
    const page = await harness();
    await page.evaluate(() => window.opening.skip());
    assert.equal(await page.locator("#stage").evaluate(node => node.inert), true);
    await page.evaluate(() => window.opening.fail(new Error("Synthetic renderer failure")));
    assert.equal(await page.locator(".opening-retry").isVisible(), true);
    assert.match(await page.locator(".opening-status").textContent(), /Synthetic renderer failure/);
    await page.screenshot({ path: join(output, "loading-error.png") });
    record("early entry cannot bypass resources; failure exposes reload");
    await page.close();
  }
  {
    const page = await harness();
    await page.evaluate(() => window.opening.setReduced(true));
    assert.equal(await page.locator("#stage").evaluate(node => node.inert), true);
    await page.evaluate(() => window.opening.completeLoading());
    assert.equal(await page.locator(".rhine-loading").isHidden(), true);
    record("existing explicit reduced preference still respects readiness");
    await page.close();
  }
  // Exercise the real music page, rather than only the loading controller.
  if (process.env.OPENING_SKIP_DEMO !== "1") {
    const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
    page.on("pageerror", error => errors.push(String(error)));
    await page.goto(base + "/?demo=1&lab=0");
    console.log("demo loaded");
    await page.locator(".rhine-loading").waitFor();
    await page.locator(".rhine-loading").press("Enter");
    console.log("demo entry requested");
    await page.locator(".rhine-loading").waitFor({ state: "hidden", timeout: 60000 });
    console.log("demo resources ready");
    await page.locator(".music-boot-skip").click();
    await page.locator('#stage[data-music-boot="done"]').waitFor();
    assert.equal(await page.locator(".music-opening").isVisible().catch(() => false), false);
    await page.screenshot({ path: join(output, "music-handoff.png") });
    results.push("actual demo load hands off to the live shelf without the old 2D prologue");
    await page.close();
  }
  assert.deepEqual(errors, []);
  await writeFile(join(output, "result.json"), JSON.stringify({ results, errors }, null, 2));
  console.log(JSON.stringify({ output, results, errors }, null, 2));
} finally { await browser.close(); }
