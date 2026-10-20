import assert from 'node:assert/strict';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.RHINE_TEST_URL || 'http://127.0.0.1:5321';
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const page = await browser.newPage();
  await page.goto(base);
  const result = await page.evaluate(async () => {
    const [{ CoverAtlas, paintCover }, { CardAppearance }, THREE] = await Promise.all([
      import('/src/cover-atlas.ts'), import('/src/appearance.ts'), import('/node_modules/three/build/three.module.js'),
    ]);
    const checks = [];
    const check = (condition, name) => { if (!condition) throw new Error(name); checks.push(name); };
    const atlas = new CoverAtlas(16, 4096, 16);
    const pending = [];
    atlas.loadImage = () => new Promise(resolve => pending.push(resolve));
    const mesh = atlas.selected.clone();
    const group = new THREE.Group(); group.add(mesh);
    const record = id => ({ id, title: id, album: { artist: id, coverUrl: id } });
    const color = (value, transparent = false) => {
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 64;
      const context = canvas.getContext('2d'); context.fillStyle = value;
      context.fillRect(0, 0, transparent ? 32 : 64, 64);
      return { source: canvas, width: 64, height: 64 };
    };
    const red = color('red'), blue = color('blue', true), green = color('green');
    const pixels = canvas => canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    const equal = (a, b) => a.length === b.length && a.every((value, i) => value === b[i]);
    const choose = (id, image) => { atlas.selectedRecord = record(id); paintCover(atlas.selectedCanvas, atlas.selectedRecord, image); atlas.snapshot(mesh); };
    choose('A', red);
    const material = mesh.material, texture = material.map, canvas = texture.image;
    choose('B', blue);
    check(mesh.material === material && mesh.material.map === texture && texture.image === canvas, 'material, texture and canvas are reused');
    check(equal(pixels(canvas), pixels(atlas.selectedCanvas)), 'transparent replacement clears the previous artwork');
    const before = new Uint8ClampedArray(pixels(canvas));
    pending.shift()(red); await Promise.resolve();
    check(equal(pixels(canvas), before), 'late A cannot overwrite reused B');
    pending.shift()(green); await Promise.resolve();
    const expected = document.createElement('canvas'); expected.width = expected.height = 1024;
    paintCover(expected, record('B'), green);
    check(equal(pixels(canvas), pixels(expected)), 'latest B completes at the original 1024 pixel quality');
    atlas.selectedTexture.anisotropy = 2;
    choose('C', red);
    check(texture.anisotropy === 2, 'reused texture follows the current quality');
    mesh.userData.coverDisposed = true;
    const retired = new Uint8ClampedArray(pixels(canvas));
    pending.shift()(blue); await Promise.resolve();
    check(equal(pixels(canvas), retired), 'retired copy ignores its pending cover');
    choose('D', blue);
    atlas.reset();
    const reset = new Uint8ClampedArray(pixels(canvas));
    pending.shift()(red); await Promise.resolve();
    check(equal(pixels(canvas), reset), 'library reset invalidates the old asynchronous generation');
    atlas.selectedTexture.anisotropy = 8;
    choose('E', green);
    check(mesh.material === material && texture.anisotropy === 8, 'pool remains reusable after library reset');
    const final = new Uint8ClampedArray(pixels(canvas));
    atlas.dispose(); pending.shift()(red); await Promise.resolve();
    check(equal(pixels(canvas), final), 'atlas disposal prevents late painting');
    let textureDisposals = 0, materialDisposals = 0;
    texture.addEventListener('dispose', () => textureDisposals++);
    material.addEventListener('dispose', () => materialDisposals++);
    new CardAppearance().dispose(group);
    check(textureDisposals === 1 && materialDisposals === 1 && mesh.userData.coverDisposed, 'pooled cover resources are released by the scene owner');
    return checks;
  });
  assert.equal(result.length, 10);
  console.log('Cover snapshot reuse passed: ' + result.join('; ') + '.');
} finally { await browser.close(); }
