import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import * as THREE from "three";
import sharp from "sharp";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { GeometryStateCache } from "../src/render-cache.ts";
import { modelTier } from "../src/model-tiers.ts";
import { cookedTextureSource } from "../src/cooked-textures.ts";
const root = new URL("../", import.meta.url);
const manifest = JSON.parse(
  await readFile(new URL("public/cooked/manifest.json", root), "utf8"),
);
const hash = (b) => createHash("sha256").update(b).digest("hex");

test("bundled resource metadata matches the published cook manifest", async () => {
  assert.deepEqual(JSON.parse(await readFile(new URL("src/cooked-render-assets.json",root),"utf8")),manifest);
});

test("cooked proxies match the source, preserve silhouette bounds and stay within tier budgets", async () => {
  assert.equal(
    hash(await readFile(new URL("public/assets/music-case-v043.glb", root))),
    manifest.sourceHash,
  );
  const b = await readFile(
    new URL("public/cooked/music-case-proxies.glb", root),
  );
  assert.equal(hash(b), manifest.model.sha256);
  const gltf = await new GLTFLoader().parseAsync(
    b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength),
    "",
  );
  const meshes = [];
  gltf.scene.traverse((mesh) => {
    if (mesh.isMesh) meshes.push(mesh);
  });
  for (const tier of ["medium", "far"]) {
    const group = new THREE.Group();
    let triangles = 0;
    for (const mesh of meshes)
      if (mesh.name.startsWith(tier + "__")) {
        group.add(mesh);
        triangles += mesh.geometry.index.count / 3;
      }
    assert.equal(group.children.length, 3);
    assert.equal(triangles, manifest.model[tier].triangles);
    assert.ok(triangles < (tier === "medium" ? 600 : 260));
    const box = new THREE.Box3().setFromObject(group),
      size = box.getSize(new THREE.Vector3());
    assert.ok(Math.abs(size.x - 3.996) < 1e-5);
    assert.ok(Math.abs(size.y - 3.35) < 1e-5);
    assert.ok(Math.abs(size.z - 0.14) < 1e-5);
    group.traverse((o) => {
      if (o.isMesh) {
        o.geometry.dispose();
        o.material.dispose();
      }
    });
  }
});

test("cooked texture levels retain source aspect and select thumbnails without rewriting external artwork", async () => {
  for (const [path, entry] of Object.entries(manifest.textures)) {
    assert.equal(
      hash(await readFile(new URL("public/" + path, root))),
      entry.sourceHash,
    );
    for (const [limit, level] of Object.entries(entry.levels)) {
      const bytes = await readFile(
        new URL("public/cooked/" + level.file, root),
      );
      assert.equal(hash(bytes), level.sha256);
      const m = await sharp(bytes).metadata();
      assert.ok(Math.max(m.width, m.height) <= Number(limit));
      assert.ok(
        Math.abs(m.width / m.height - entry.width / entry.height) < 0.01,
      );
    }
    assert.match(cookedTextureSource("/" + path, 256).url, /-256\.webp\?v=/);
    assert.match(cookedTextureSource("/" + path, 1024).url, /-1024\.webp\?v=/);
  }
  for (const url of [
    "https://example.com/cover.png",
    "cover://user.png",
    "/demo-covers/square.png?custom=1",
  ])
    assert.deepEqual(cookedTextureSource(url, 256), { url });
});

test("LOD boundaries resist oscillation, zoom restores detail and full mode is unconditional", () => {
  let tier = 1;
  for (const p of [880, 905, 890, 920, 1000]) tier = modelTier(p, tier);
  assert.equal(tier, 1);
  tier = modelTier(1100, tier);
  assert.equal(tier, 0);
  for (const p of [1040, 920, 901]) tier = modelTier(p, tier);
  assert.equal(tier, 0);
  tier = modelTier(890, tier);
  assert.equal(tier, 1);
  tier = modelTier(230, tier);
  assert.equal(tier, 2);
  for (const p of [245, 255, 280, 250]) tier = modelTier(p, tier);
  assert.equal(tier, 2);
  assert.equal(modelTier(300, tier), 1);
  assert.equal(modelTier(1, 2, true), 0);
});

test("occlusion cache invalidates camera, instancing, attribute edits and membership but ignores lights", () => {
  const scene = new THREE.Scene(),
    camera = new THREE.PerspectiveCamera(),
    cache = new GeometryStateCache();
  const make = () =>
    new THREE.InstancedMesh(
      new THREE.BoxGeometry(),
      new THREE.MeshStandardMaterial(),
      2,
    );
  const a = make(),
    b = make();
  scene.add(a);
  assert.equal(cache.changed(scene, camera), true);
  assert.equal(cache.changed(scene, camera), false);
  const light = new THREE.DirectionalLight();
  scene.add(light);
  light.position.x = 5;
  assert.equal(cache.changed(scene, camera), false);
  camera.fov = 45;
  camera.updateProjectionMatrix();
  assert.equal(cache.changed(scene, camera), true);
  a.instanceMatrix.needsUpdate = true;
  assert.equal(cache.changed(scene, camera), true);
  a.geometry.attributes.position.needsUpdate = true;
  assert.equal(cache.changed(scene, camera), true);
  scene.remove(a);
  scene.add(b);
  assert.equal(cache.changed(scene, camera), true);
  scene.remove(b);
  scene.add(a);
  assert.equal(cache.changed(scene, camera), true);
  a.position.x = 1;
  assert.equal(cache.changed(scene, camera), true);
  assert.equal(cache.changed(scene, camera), false);
  a.count = 1;
  assert.equal(cache.changed(scene, camera), true);
  for (const mesh of [a, b]) {
    mesh.dispose();
    mesh.geometry.dispose();
    mesh.material.dispose();
  }
});
