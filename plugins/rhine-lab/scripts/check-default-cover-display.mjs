import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.RHINE_TEST_URL || 'http://127.0.0.1:5321';
const evidence = process.env.RHINE_EVIDENCE_DIR || '.cache/default-cover-evidence';
await mkdir(evidence, { recursive: true });
const library = {
  version: 1, roots: [], scan: { running: false }, onlineEnabled: false,
  genres: Array.from({ length: 3 }, (_, i) => ({ id: `genre-${i}`, name: `分类 ${i + 1}` })),
  albums: Array.from({ length: 24 }, (_, i) => ({
    id: `album-${i}`, title: `封面测试 ${String(i + 1).padStart(2, '0')}`, artist: `歌手 ${i % 3 + 1}`,
    genreId: `genre-${i % 3}`, folder: 'synthetic', rawGenres: [], producers: [], offline: false,
    coverUrl: i === 23 ? undefined : `/test-covers/${i}.svg`, tracks: [],
  })),
};
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  page.setDefaultTimeout(30000);
  const errors = [];
  page.on('pageerror', error => { errors.push(error.stack); console.error(error.stack); });
  page.on('console', message => { if (message.type() === 'error' && /WebGLProgram|VALIDATE_STATUS/.test(message.text())) errors.push(message.text()); });
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    const json = path === '/api/library' ? library : path === '/api/audio/capabilities'
      ? { nativeAvailable: false, decoderAvailable: false, devices: [{ id: 'default', name: '系统默认输出' }] } : {};
    return route.fulfill({ json });
  });
  await page.route('**/test-covers/**', route => route.fulfill({ contentType: 'image/svg+xml',
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"><path fill="#ff00ff" d="M0 0h512v512H0z"/></svg>' }));
  const start = async () => {
    await page.goto(base + '/?lab=0');
    await page.locator('.rhine-loading').press('Enter');
    await page.locator('.rhine-loading').waitFor({ state: 'hidden', timeout: 60000 });
    await page.locator('.music-boot-skip').click();
    await page.locator('#stage[data-music-boot="done"]').waitFor();
    // Capture the actual scene when a production handler updates it.
    await page.evaluate(async () => {
    // Vite may give dependencies HMR timestamps. Import the same module URLs
    // as the live app rather than creating a second class/data singleton.
    const source = await (await fetch('/src/music-app.ts')).text();
    const sceneUrl = source.match(/from "([^"\n]*\/scene\.ts[^"\n]*)"/)[1];
    const dataUrl = source.match(/from "([^"\n]*\/data\.ts[^"\n]*)"/)[1];
    const { ArchiveScene } = await import(sceneUrl);
    window.coverTestRecords = (await import(dataUrl)).records;
    const refresh = ArchiveScene.prototype.refreshCovers;
    const state = scene => JSON.stringify([scene.selectedCell, scene.camera.position.toArray(),
      scene.model.position.toArray(), scene.model.quaternion.toArray(), scene.lift,
      scene.outgoing.map(item => [item.cell, item.group.position.toArray()])]);
    ArchiveScene.prototype.refreshCovers = function () {
      window.coverTestScene = this;
      const before = state(this); refresh.call(this);
      if (before !== state(this)) throw new Error('Cover switch changed camera, selection or animation');
    };
    });
  };
  await start();
  const openSettings = () => page.locator('.music-topnav [data-action="settings"]').click();
  const closePanel = () => page.locator('[data-action="close-panel"]').click();
  await openSettings();
  const checkbox = page.getByRole('checkbox', { name: '使用默认封面', exact: true });
  assert.equal(await checkbox.isChecked(), false, 'existing users retain original covers');
  await checkbox.check();
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('rhine-music-preferences')).useDefaultCovers === true);
  await page.screenshot({ path: evidence + '/settings.png' });
  await closePanel();
  await page.waitForTimeout(500);
  const readLive = () => page.evaluate(async () => {
    const scene = window.coverTestScene;
    await scene.covers.prepareVisible(3000);
    return { urls: [...scene.covers.decodedImages.keys()], selected: scene.covers.selectedKey,
      raw: window.coverTestRecords.filter(item => item.album.coverUrl).every(item => item.album.coverUrl.startsWith('/test-covers/')) };
  });
  const live = await readLive();
  assert.deepEqual(live.urls, ['/demo-covers/square.png'], 'day shelf loads one light cover');
  assert.ok(live.selected.includes('/demo-covers/square.png'));
  assert.ok(live.raw, 'actual library artwork remains untouched');
  await page.screenshot({ path: evidence + '/default-covers.png' });
  await page.locator('.music-topnav [data-action="search"]').click();
  const defaultSources = await page.locator('#album-results img').evaluateAll(images => images.map(image => image.getAttribute('src')));
  assert.equal(defaultSources.length, 24);
  assert.deepEqual([...new Set(defaultSources)], ['/demo-covers/square.png'], 'all day thumbnails share one light cover, including missing originals');
  await closePanel();
  await openSettings();
  await page.locator('.theme-cards [data-theme="night"]').click();
  await closePanel();
  const night = await readLive();
  assert.deepEqual(night.urls, ['/demo-covers/portrait.png'], 'night shelf loads one dark cover');
  assert.ok(night.selected.includes('/demo-covers/portrait.png'));
  await page.waitForTimeout(700);
  await page.screenshot({ path: evidence + '/default-covers-night.png' });
  await page.locator('.music-topnav [data-action="search"]').click();
  const nightSources = await page.locator('#album-results img').evaluateAll(images => images.map(image => image.getAttribute('src')));
  assert.equal(nightSources.length, 24);
  assert.deepEqual([...new Set(nightSources)], ['/demo-covers/portrait.png'], 'all night thumbnails share one dark cover');
  await closePanel();
  await page.evaluate(() => {
    window.coverRevealFrames = [];
    const sample = () => {
      const reveal = window.coverTestScene.covers.selectedReveal;
      window.coverRevealFrames.push(reveal.amount.value);
      if (window.coverRevealFrames.length < 1200) requestAnimationFrame(sample);
    };
    sample();
  });
  await page.locator('[data-action="open"]').click();
  await page.locator('#music-detail:not([hidden])').waitFor();
  await page.waitForFunction(() => window.coverTestScene.covers.selectedReveal.amount.value > 0.999);
  const extracted = await page.evaluate(() => {
    const atlas = window.coverTestScene.covers;
    const original = atlas.selectedReveal.canvas.getContext('2d').getImageData(512, 512, 1, 1).data;
    return { pixel: [...original], frames: window.coverRevealFrames,
      shelf: atlas.tileKeys.filter(Boolean), id: atlas.selectedRecord.id };
  });
  assert.deepEqual(extracted.pixel, [255, 0, 255, 255], 'extracted card reveals its real image');
  assert.ok(extracted.frames.filter(value => value > 0.05 && value < 0.95).length > 3, 'extraction animates through intermediate cover blends');
  assert.ok(extracted.shelf.every(key => key.includes('/demo-covers/portrait.png')), 'background shelf stays uniformly dark');
  await page.waitForFunction(() => document.querySelector('#album-detail-content').getAnimations({ subtree: true }).every(animation => animation.playState !== 'running'));
  await page.waitForFunction(() => !document.querySelector('#album-detail-content .document-redaction-window'));
  await page.screenshot({ path: evidence + '/extracted-real-cover.png' });
  const resumed = await page.evaluate(() => {
    const scene = window.coverTestScene, atlas = scene.covers;
    const index = window.coverTestRecords.indexOf(atlas.selectedRecord);
    scene.switchMusicAlbum((index + 1) % window.coverTestRecords.length);
    const returning = scene.outgoing.find(item => item.group.children.some(child =>
      child.userData.albumCover && atlas.snapshots.get(child)?.record === window.coverTestRecords[index]));
    if (!returning) throw Error('Extracted card did not become a returning copy');
    const cover = returning.group.children.find(child => child.userData.albumCover);
    const before = atlas.snapshots.get(cover).reveal.amount.value;
    scene.switchMusicAlbum(index);
    return { before, after: atlas.selectedReveal.amount.value };
  });
  assert.equal(resumed.before, 1);
  assert.equal(resumed.after, resumed.before, 'production rapid reselection transfers the visible cover before retiring its copy');
  await page.waitForFunction(() => window.coverTestScene.musicPresentationReady);
  await page.locator('[data-action="back"]').click();
  await page.waitForFunction(() => window.coverTestScene.musicArchiveReady && window.coverTestScene.covers.selectedReveal.amount.value === 0);
  await page.locator('[data-action="open"]').waitFor({ state: 'visible' });
  await page.screenshot({ path: evidence + '/returned-default-cover.png' });
  await page.locator('[data-action="open"]').click();
  await page.locator('#music-detail:not([hidden])').waitFor();
  const title = await page.locator('#selection-title').textContent();
  await openSettings(); await checkbox.uncheck(); await closePanel();
  await page.locator('#music-detail:not([hidden])').waitFor();
  assert.equal(await page.locator('#selection-title').textContent(), title, 'detail selection survives both directions');
  await openSettings(); await checkbox.check(); await closePanel();
  await start();
  assert.equal(await page.locator('#stage').getAttribute('data-theme'), 'night', 'theme survives reload');
  await openSettings();
  assert.ok(await checkbox.isChecked(), 'preference survives reload');
  await closePanel();
  await page.locator('.music-topnav [data-action="search"]').click();
  assert.deepEqual(await page.locator('#album-results img').evaluateAll(images => images.map(image => image.getAttribute('src'))), nightSources,
    'one dark cover is restored on a saved night launch');
  await closePanel(); await openSettings();
  await page.locator('.theme-cards [data-theme="day"]').click();
  await closePanel();
  const dayAgain = await readLive();
  assert.deepEqual(dayAgain.urls, ['/demo-covers/square.png'], 'switching back removes all dark covers');
  await page.locator('.music-topnav [data-action="search"]').click();
  assert.deepEqual(await page.locator('#album-results img').evaluateAll(images => images.map(image => image.getAttribute('src'))), defaultSources);
  await closePanel(); await openSettings(); await checkbox.uncheck(); await closePanel();
  await page.locator('.music-topnav [data-action="search"]').click();
  const restored = await page.locator('#album-results img').evaluateAll(images => images.map(image => image.getAttribute('src')));
  assert.equal(restored.filter(url => url.startsWith('/test-covers/')).length, 23);
  assert.equal(restored.filter(url => url.startsWith('data:image/')).length, 1);
  assert.deepEqual(errors, []);
  console.log('Default cover display passed: uniform day/night shelves and search, animated real-cover extraction, default-cover return, immediate theme updates, saved night launch, camera continuity, and original-cover restore.');
} finally { await browser.close(); }
