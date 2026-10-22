import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { FrameLimiter, frameRates } from "../src/frame-limiter.ts";
import {
  normalizeQuality,
  qualityPresets,
  matchingPreset,
  restoreOriginalQuality,
} from "../src/render-quality.ts";
import { ShadowCache, writeMatrixIfChanged } from "../src/render-cache.ts";

test("defaults, legacy storage and FPS changes preserve independent quality choices", () => {
  assert.equal(normalizeQuality(null).antialias,"off");
  for(const antialias of ['off','fxaa','smaa'])assert.equal(normalizeQuality({antialias}).antialias,antialias);
  assert.equal(normalizeQuality(null).frameRate, 60);
  assert.equal(normalizeQuality(null).pixelRatio, 1.5);
  assert.equal(normalizeQuality(null).modelDetail, "full");
  assert.equal(normalizeQuality({ pixelRatio: 1.5 }).pixelRatio, 1.5);
  for (const bad of [null, undefined, 0, -1, NaN, Infinity, "120", 144])
    assert.equal(normalizeQuality({ frameRate: bad }).frameRate, 60);
  for (const frameRate of frameRates) {
    const saved = { ...qualityPresets.original, frameRate };
    assert.deepEqual(
      normalizeQuality(JSON.parse(JSON.stringify(saved))),
      saved,
    );
    assert.equal(matchingPreset(saved), "original");
  }
});

test("repair old stock quality once, preserving custom settings and FPS", () => {
  const stock = { ...qualityPresets.original, frameRate: 30, pixelRatio: 1 };
  delete stock.modelDetail;
  for (const antialias of ["off", "fxaa"]) {
    const old = { ...stock, antialias };
    assert.deepEqual(restoreOriginalQuality(old, "original", undefined), { ...qualityPresets.original, frameRate: 30 });
    assert.deepEqual(restoreOriginalQuality(old, "original", 1), normalizeQuality(old));
    assert.deepEqual(restoreOriginalQuality(old, "performance", undefined), normalizeQuality(old));
  }
  for (const custom of [{scale:95},{antialias:"smaa"},{pixelRatio:2},{modelDetail:"full"},{aoSamples:16}]) {
    const old = { ...stock, ...custom };
    assert.deepEqual(restoreOriginalQuality(old,"original",undefined),normalizeQuality(old));
  }
});

test("actual submissions follow every cap on common and non-divisible refresh rates", () => {
  for (const hz of [60, 120, 144, 165, 240])
    for (const cap of frameRates) {
      const limiter = new FrameLimiter();
      let frames = 0;
      for (let i = 0; i < hz * 10; i++)
        if (limiter.shouldRender((i * 1000) / hz, cap)) frames++;
      assert.ok(
        Math.abs(frames - Math.min(hz, cap) * 10) <= 1,
        `${hz} Hz / ${cap} FPS: ${frames}`,
      );
    }
});

test("frame limit changes, hidden-page resume and long stalls do not catch up", () => {
  const limiter = new FrameLimiter();
  assert.equal(limiter.shouldRender(0, 24), true);
  assert.equal(limiter.shouldRender(10, 24), false);
  assert.equal(limiter.shouldRender(10, 120), true);
  assert.equal(limiter.shouldRender(10000, 120), true);
  assert.equal(limiter.shouldRender(10000, 120), false);
  limiter.reset();
  assert.equal(limiter.shouldRender(10001, 120), true);
});

test("settled matrices avoid uploads without rounding away a GPU-visible change", () => {
  const data = new Float32Array(32),
    matrix = new THREE.Matrix4().makeTranslation(1.1, 2, 3);
  assert.equal(writeMatrixIfChanged(data, 16, matrix.elements), true);
  assert.equal(writeMatrixIfChanged(data, 16, matrix.elements), false);
  matrix.elements[12] += 1e-12;
  assert.equal(writeMatrixIfChanged(data, 16, matrix.elements), false);
  matrix.elements[12] += 0.001;
  assert.equal(writeMatrixIfChanged(data, 16, matrix.elements), true);
  assert.deepEqual([...data.slice(16)], matrix.elements.map(Math.fround));
});

test("shadow cache follows parent motion, instancing, light targets and caster visibility", () => {
  const scene = new THREE.Scene(),
    cache = new ShadowCache();
  const parent = new THREE.Group();
  scene.add(parent);
  const mesh = new THREE.InstancedMesh(
    new THREE.BoxGeometry(),
    new THREE.MeshStandardMaterial(),
    2,
  );
  mesh.castShadow = true;
  parent.add(mesh);
  const light = new THREE.DirectionalLight();
  light.castShadow = true;
  scene.add(light, light.target);
  assert.equal(cache.changed(scene), true);
  assert.equal(cache.changed(scene), false);
  parent.position.x = 1;
  assert.equal(cache.changed(scene), true);
  assert.equal(cache.changed(scene), false);
  mesh.instanceMatrix.needsUpdate = true;
  assert.equal(cache.changed(scene), true);
  light.target.position.x = 2;
  assert.equal(cache.changed(scene), true);
  parent.visible = false;
  assert.equal(cache.changed(scene), true);
  assert.equal(cache.changed(scene), false);
  parent.visible = true;
  assert.equal(cache.changed(scene), true);
  assert.equal(cache.changed(scene), false);
  mesh.material.visible = false;
  assert.equal(cache.changed(scene), true);
  scene.remove(parent);
  assert.equal(cache.changed(scene), true);
  mesh.geometry.dispose();
  mesh.material.dispose();
});
