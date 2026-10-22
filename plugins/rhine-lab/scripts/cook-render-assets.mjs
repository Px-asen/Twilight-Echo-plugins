import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import sharp from "sharp";
import * as THREE from "three";
import {
  mergeGeometries,
  mergeVertices,
} from "three/addons/utils/BufferGeometryUtils.js";
import { GLTFExporter } from "three/addons/exporters/GLTFExporter.js";

// Proxies derive from the authored construction, never destructive mesh edits.
globalThis.FileReader ??= class {
  readAsArrayBuffer(blob) {
    blob.arrayBuffer().then((result) => {
      this.result = result;
      this.onloadend?.();
    });
  }
};
const root = new URL("../", import.meta.url);
const output = new URL("public/cooked/", root);
await mkdir(output, { recursive: true });
const source = JSON.parse(
  await readFile(new URL("art/music-case-v043.json", root), "utf8"),
);
const sourceBytes = await readFile(
  new URL("public/assets/music-case-v043.glb", root),
);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
if (hash(sourceBytes) !== source.sha256)
  throw new Error(
    "Model construction and source GLB disagree; rebuild the authored model first.",
  );
function roundedRect(w, h, r) {
  const s = new THREE.Shape(),
    x = -w / 2,
    y = -h / 2;
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r);
  s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h);
  s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r);
  s.quadraticCurveTo(x, y, x + r, y);
  return s;
}
const group = new THREE.Group(),
  models = {};
for (const tier of ["medium", "far"]) {
  const parts = new Map();
  let triangles = 0;
  for (const c of source.construction) {
    const [w, h, d] = c.size,
      bevel = tier === "medium" ? c.bevel : 0;
    const shape = roundedRect(
      w - 2 * bevel,
      h - 2 * bevel,
      Math.max(0.001, c.radius - bevel),
    );
    if (c.hole)
      shape.holes.push(
        new THREE.Path(
          roundedRect(c.hole[0] + 2 * bevel, c.hole[1] + 2 * bevel, c.radius)
            .getPoints(1)
            .reverse(),
        ),
      );
    const g = new THREE.ExtrudeGeometry(shape, {
      depth: d - 2 * bevel,
      steps: 1,
      bevelEnabled: bevel > 0,
      bevelSegments: 1,
      bevelSize: bevel,
      bevelThickness: bevel,
      curveSegments: 1,
    });
    g.translate(c.center[0], c.center[1], c.center[2] - d / 2 + bevel);
    g.clearGroups();
    if (!parts.has(c.surface)) parts.set(c.surface, []);
    parts.get(c.surface).push(g);
  }
  for (const [surface, gs] of parts) {
    const geometry = mergeVertices(mergeGeometries(gs), 1e-6);
    const material = new THREE.MeshStandardMaterial({ name: surface });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `${tier}__${surface}`;
    group.add(mesh);
    triangles += geometry.index.count / 3;
    gs.forEach((g) => g.dispose());
  }
  models[tier] = { triangles };
}
const model = Buffer.from(
  await new GLTFExporter().parseAsync(group, { binary: true }),
);
await writeFile(new URL("music-case-proxies.glb", output), model);
const textures = {};
for (const name of ["square", "portrait", "landscape"]) {
  const input = await readFile(new URL(`public/demo-covers/${name}.png`, root));
  const metadata = await sharp(input).metadata(),
    levels = {};
  for (const size of [256, 1024]) {
    // Retain alpha, aspect ratio and sRGB; source art remains untouched.
    const bytes = await sharp(input)
      .rotate()
      .resize({
        width: size,
        height: size,
        fit: "inside",
        withoutEnlargement: true,
      })
      .toColourspace("srgb")
      .webp({ lossless: true, effort: 6 })
      .toBuffer();
    const file = `${name}-${size}.webp`;
    await writeFile(new URL(file, output), bytes);
    levels[size] = { file, bytes: bytes.length, sha256: hash(bytes) };
  }
  textures[`demo-covers/${name}.png`] = {
    width: metadata.width,
    height: metadata.height,
    sourceBytes: input.length,
    sourceHash: hash(input),
    levels,
  };
}
const manifest = {
  version: 1,
  sourceHash: source.sha256,
  model: {
    file: "music-case-proxies.glb",
    sha256: hash(model),
    bytes: model.length,
    fullTriangles: source.triangles,
    ...models,
  },
  textures,
};
await writeFile(
  new URL("manifest.json", output),
  JSON.stringify(manifest, null, 2) + "\n",
);
await writeFile(
  new URL("src/cooked-render-assets.json", root),
  JSON.stringify(manifest, null, 2) + "\n",
);
console.log(
  JSON.stringify({
    model: manifest.model,
    textures: Object.values(textures).map((t) => ({
      source: t.sourceBytes,
      cooked: Object.values(t.levels).reduce((s, l) => s + l.bytes, 0),
    })),
  }),
);
