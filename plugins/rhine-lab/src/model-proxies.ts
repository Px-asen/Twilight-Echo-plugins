import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { assetUrl } from "./asset-url.ts";
import manifest from "./cooked-render-assets.json" with { type: "json" };
import { modelTier } from "./model-tiers.ts";
import { MUSIC_MODEL } from "./music-model.ts";
import { writeMatrixIfChanged } from "./render-cache.ts";

export type ModelDetail = "auto" | "full";

/** Compact only shell instances: cover tile IDs and logical cells never move.
 * All nonzero slots remain casters even outside the viewing frustum. */
export class ModelProxies {
  private readonly tiers: Uint8Array;
  private readonly matrices: THREE.InstancedBufferAttribute[];
  private readonly batches: THREE.InstancedMesh[][] = [[], [], []];
  private counts = [0, 0, 0];
  private readonly cameraState = new Float32Array(32);
  private lastVersion = -1;
  private lastHeight = 0;
  private lastDetail?: ModelDetail;
  readonly pick: THREE.InstancedMesh;
  private constructor(
    private readonly sources: THREE.InstancedMesh[],
    geometries: Map<string, THREE.BufferGeometry>,
    scene: THREE.Scene,
  ) {
    const count = sources[0].count;
    this.tiers = new Uint8Array(count);
    this.tiers.fill(1);
    this.matrices = [0, 1, 2].map(() =>
      new THREE.InstancedBufferAttribute(
        new Float32Array(count * 16),
        16,
      ).setUsage(THREE.DynamicDrawUsage),
    );
    for (const source of sources) {
      scene.remove(source);
      const surface = (source.material as THREE.Material).name.replace(
        /\.\d+$/,
        "",
      );
      for (let tier = 0; tier < 3; tier++) {
        const geometry =
          tier === 0
            ? source.geometry
            : geometries.get(`${tier === 1 ? "medium" : "far"}__${surface}`);
        if (!geometry)
          throw new Error(`Missing cooked geometry: ${surface}/${tier}`);
        const batch = new THREE.InstancedMesh(geometry, source.material, count);
        batch.name = `Music shell ${surface} / ${tier}`;
        batch.instanceMatrix = this.matrices[tier];
        batch.count = 0;
        batch.castShadow = source.castShadow;
        batch.receiveShadow = source.receiveShadow;
        batch.frustumCulled = false;
        this.batches[tier].push(batch);
        scene.add(batch);
      }
    }
    // Pick the lid proxy with the canonical, uncompacted slot buffer. Picking a
    // compact batch would mistake a local instance index for a library cell.
    const lid =
      sources.find((s) =>
        (s.material as THREE.Material).name.startsWith("Frosted_Polymer"),
      ) ?? sources[0];
    this.pick = new THREE.InstancedMesh(
      geometries.get("medium__Frosted_Polymer") ?? lid.geometry,
      lid.material,
      count,
    );
    this.pick.instanceMatrix = sources[0].instanceMatrix;
    this.pick.frustumCulled = false;
  }
  static async create(
    sources: THREE.InstancedMesh[],
    scene: THREE.Scene,
    cancelled = () => false,
  ) {
    const gltf = await new GLTFLoader().loadAsync(
      assetUrl(
        `cooked/${manifest.model.file}?v=${manifest.model.sha256.slice(0, 12)}`,
      ),
    );
    const geometries = new Map<string, THREE.BufferGeometry>();
    gltf.scene.traverse((object) => {
      if (object instanceof THREE.Mesh) {
        geometries.set(object.name, object.geometry);
        (object.material as THREE.Material).dispose();
      }
    });
    if (cancelled()) {
      for (const geometry of geometries.values()) geometry.dispose();
      return undefined;
    }
    return new ModelProxies(sources, geometries, scene);
  }
  update(camera: THREE.PerspectiveCamera, height: number, detail: ModelDetail) {
    const cameraChanged = writeMatrixIfChanged(
      this.cameraState,
      0,
      camera.matrixWorldInverse.elements,
    );
    const lensChanged = writeMatrixIfChanged(
      this.cameraState,
      16,
      camera.projectionMatrix.elements,
    );
    const version = this.sources[0].instanceMatrix.version;
    if (
      !cameraChanged &&
      !lensChanged &&
      version === this.lastVersion &&
      height === this.lastHeight &&
      detail === this.lastDetail
    )
      return;
    if (version !== this.lastVersion) {
      this.pick.boundingSphere = null;
      this.pick.boundingBox = null;
    }
    this.lastVersion = version;
    this.lastHeight = height;
    this.lastDetail = detail;
    const source = this.sources[0].instanceMatrix.array as Float32Array;
    const counts = [0, 0, 0],
      changed = [false, false, false];
    const pixelsPerUnit = height * 0.5 * camera.projectionMatrix.elements[5];
    const view = camera.matrixWorldInverse.elements;
    // No temporary arrays/matrices per slot and no GPU uploads for a settled pool.
    for (let slot = 0; slot < this.tiers.length; slot++) {
      const offset = slot * 16;
      if (
        source[offset] === 0 &&
        source[offset + 5] === 0 &&
        source[offset + 10] === 0
      )
        continue;
      const x = source[offset + 12] + MUSIC_MODEL.center.y * source[offset + 4],
        y = source[offset + 13] + MUSIC_MODEL.center.y * source[offset + 5],
        z = source[offset + 14] + MUSIC_MODEL.center.y * source[offset + 6];
      const depth = -(view[2] * x + view[6] * y + view[10] * z + view[14]);
      const pixels =
        (MUSIC_MODEL.width * pixelsPerUnit) / Math.max(camera.near, depth);
      const tier = modelTier(pixels, this.tiers[slot], detail === "full");
      this.tiers[slot] = tier;
      const target = this.matrices[tier].array as Float32Array,
        destination = counts[tier]++ * 16;
      for (let i = 0; i < 16; i++)
        if (target[destination + i] !== source[offset + i]) {
          target[destination + i] = source[offset + i];
          changed[tier] = true;
        }
    }
    for (let tier = 0; tier < 3; tier++) {
      if (changed[tier]) this.matrices[tier].needsUpdate = true;
      for (const batch of this.batches[tier]) {
        batch.count = counts[tier];
        batch.visible = counts[tier] > 0;
      }
    }
    this.counts = counts;
  }
  getStats() {
    return {
      full: this.counts[0],
      medium: this.counts[1],
      far: this.counts[2],
      sourceTriangles: manifest.model.fullTriangles,
      shellTriangles:
        this.counts[0] * manifest.model.fullTriangles +
        this.counts[1] * manifest.model.medium.triangles +
        this.counts[2] * manifest.model.far.triangles,
    };
  }
  dispose() {
    // InstancedMesh owns buffers independently of its shared geometry/material.
    for (const source of this.sources) source.dispose();
    this.pick.dispose();
    for (const tier of this.batches) for (const batch of tier) batch.dispose();
  }
}
