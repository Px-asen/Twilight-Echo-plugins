import * as THREE from "three";
import { generatedCoverSource } from "./generated-album-cover.ts";
import { getAlbumCoverUrl, usesDefaultCovers } from "./music-cover-display.ts";
import type { MusicSelectionLighting } from "./music-lighting";
import type { ArchiveRecord } from "./data";
import { trackAtlasUnpack, type AtlasUnpackState } from "./atlas-upload-state.ts";
import { MUSIC_COVER, createAlbumPrintMaterial } from "./music-model.ts";
import { cookedTextureSource } from "./cooked-textures.ts";

// Paper insert inside the thin lid, shared by shelf, selection and viewer.
export const COVER_SIZE = MUSIC_COVER;
export type CoverImage = { source: CanvasImageSource; width: number; height: number };
type DecodedCoverImage = CoverImage & { decodedSize: number; pixels: number };
type DecodeJob = { url: string; generation: number; size: number; resolve: (image: DecodedCoverImage | undefined) => void; image?: HTMLImageElement };
export const COVER_PAINT_SIZE = 1024;
// Use the same UV margin at every texture resolution. A fixed two-pixel inset
// made the 256px atlas artwork smaller than its 1024px lifted/returning copy.
export const COVER_INSET = 1 / 64;
const COVER_PAINT_MARGIN = COVER_PAINT_SIZE * COVER_INSET;
const coverEase = (value: number) => value * value * (3 - 2 * value);

export function containCover(
  width: number,
  height: number,
  boxWidth: number,
  boxHeight: number,
) {
  const scale = Math.min(
    boxWidth / Math.max(1, width),
    boxHeight / Math.max(1, height),
  );
  const drawnWidth = width * scale,
    drawnHeight = height * scale;
  return {
    x: (boxWidth - drawnWidth) / 2,
    y: (boxHeight - drawnHeight) / 2,
    width: drawnWidth,
    height: drawnHeight,
  };
}

export function paintCover(
  canvas: HTMLCanvasElement,
  record: (Pick<ArchiveRecord, "title"> & Partial<Pick<ArchiveRecord, "id" | "en" | "album">> & { artist?: string }) | undefined,
  image?: CoverImage,
) {
  const metadata = { id: record?.id, title: record?.title ?? "未命名专辑", artist: record?.album?.artist ?? record?.artist ?? record?.en };
  const generated = !image ? generatedCoverSource(metadata) : undefined;
  if (generated) image = { source: generated, width: generated.width, height: generated.height };
  const context = canvas.getContext("2d")!;
  // Paint in one logical coordinate space, including fallback art and labels.
  // Ownership can move between atlas/selection/snapshot without rescaling art.
  const width = COVER_PAINT_SIZE,
    height = COVER_PAINT_SIZE,
    margin = COVER_PAINT_MARGIN;
  context.setTransform(canvas.width / width, 0, 0, canvas.height / height, 0, 0);
  context.clearRect(0, 0, width, height);
  if (image) {
    const box = containCover(image.width, image.height, width - margin * 2, height - margin * 2);
    context.drawImage(
      image.source,
      box.x + margin,
      box.y + margin,
      box.width,
      box.height,
    );
    return;
  }
}

/** One print, two sources. Only uniforms change during extraction; original
 * canvases/textures are allocated on demand and retained by the existing pool. */
class CoverReveal {
  readonly baseCompile: THREE.MeshLambertMaterial["onBeforeCompile"];
  readonly baseCacheKey: THREE.MeshLambertMaterial["customProgramCacheKey"];
  readonly amount = { value: 0 };
  readonly original: { value: THREE.Texture };
  canvas?: HTMLCanvasElement;
  texture?: THREE.CanvasTexture;
  revision = 0;
  requested = false;
  ready = false;
  readyTime = 0;
  progress = 0;
  disposed = false;

  constructor(material: THREE.MeshLambertMaterial) {
    this.baseCompile = material.onBeforeCompile;
    this.baseCacheKey = material.customProgramCacheKey;
    this.original = { value: material.map! };
    material.onBeforeCompile = (shader, renderer) => {
      this.baseCompile.call(material, shader, renderer);
      shader.uniforms.coverOriginal = this.original;
      shader.uniforms.coverReveal = this.amount;
      shader.fragmentShader = "uniform sampler2D coverOriginal;\nuniform float coverReveal;\n" + shader.fragmentShader;
      shader.fragmentShader = shader.fragmentShader.replace("#include <map_fragment>", `
        vec4 shelfPrint = texture2D(map, vMapUv);
        vec4 albumPrint = shelfPrint;
        if (coverReveal > 0.0) albumPrint = texture2D(coverOriginal, vMapUv);
        float printAlpha = mix(shelfPrint.a, albumPrint.a, coverReveal);
        vec3 printColor = mix(shelfPrint.rgb * shelfPrint.a, albumPrint.rgb * albumPrint.a, coverReveal);
        diffuseColor *= vec4(printColor / max(printAlpha, 0.00001), printAlpha);
      `);
    };
    material.customProgramCacheKey = () => this.baseCacheKey.call(material) + "-cover-reveal-v1";
    material.addEventListener("dispose", () => {
      this.disposed = true;
      this.revision++;
      this.texture?.dispose();
      if (this.canvas) this.canvas.width = this.canvas.height = 1;
    });
  }

  private source(anisotropy: number) {
    if (!this.canvas) {
      this.canvas = document.createElement("canvas");
      this.canvas.width = this.canvas.height = COVER_PAINT_SIZE;
      this.texture = new THREE.CanvasTexture(this.canvas);
      this.texture.colorSpace = THREE.SRGBColorSpace;
      this.texture.userData.maxAnisotropy = 8;
    }
    this.texture!.anisotropy = anisotropy;
    this.original.value = this.texture!;
    return this.canvas;
  }

  paint(record: ArchiveRecord | undefined, image: CoverImage | undefined, anisotropy: number) {
    paintCover(this.source(anisotropy), record, image);
    this.texture!.needsUpdate = true;
    this.ready = true;
  }

  setAnisotropy(anisotropy: number) {
    if (!this.texture || this.texture.anisotropy === anisotropy) return;
    this.texture.anisotropy = anisotropy;
    this.texture.needsUpdate = true;
  }

  reset() {
    this.revision++;
    this.requested = this.ready = false;
    this.readyTime = this.progress = this.amount.value = 0;
  }

  copyFrom(source: CoverReveal, anisotropy: number) {
    this.reset();
    this.requested = false; // Own the pending completion with this snapshot's revision.
    this.ready = source.ready;
    this.readyTime = source.readyTime;
    this.progress = source.progress;
    this.amount.value = source.amount.value;
    if (source.ready && source.canvas) {
      const canvas = this.source(anisotropy), context = canvas.getContext("2d")!;
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.drawImage(source.canvas, 0, 0);
      this.texture!.needsUpdate = true;
    }
  }

  update(progress: number, dt: number) {
    this.progress = Math.max(0, Math.min(1, progress));
    if (this.ready) this.readyTime = Math.min(1, this.readyTime + dt / 0.24);
    // Start after the preview position and finish while the card is clearing
    // the shelf. Late artwork gets its own brief fade instead of popping in.
    const extraction = Math.max(0, Math.min(1, (this.progress - 0.04) / 0.58));
    this.amount.value = coverEase(extraction) * coverEase(this.readyTime);
  }
}

/** Three r183's single-copy API reads GPU unpack state for every region.
 * Preserve it once around this atlas-only batch, keeping Three's texture
 * binding cache in sync. Unknown renderer internals use the public copy API. */
function beginAtlasUpload(renderer: THREE.WebGLRenderer, texture: THREE.Texture, cached?: AtlasUnpackState) {
  if (THREE.REVISION !== "183") return undefined;
  const handle = (renderer.properties.get(texture) as { __webglTexture?: WebGLTexture }).__webglTexture;
  if (!handle) return undefined;
  const gl = renderer.getContext();
  if (!(gl instanceof WebGL2RenderingContext)) return undefined;
  const state = cached ?? trackAtlasUnpack(gl);
  const { parameters, values } = state;
  const previous = parameters.map(parameter => values.get(parameter)!);
  renderer.state.bindTexture(gl.TEXTURE_2D, handle, gl.TEXTURE0);
  for (const parameter of parameters.slice(0, 5)) gl.pixelStorei(parameter, 0);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, texture.flipY);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, texture.premultiplyAlpha);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, texture.unpackAlignment);
  return {
    state,
    copy(canvas: HTMLCanvasElement, x: number, y: number) {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
    },
    end() {
      for (let i = 0; i < parameters.length; i++) gl.pixelStorei(parameters[i], previous[i]);
      renderer.state.unbindTexture();
    },
  };
}

/** One fixed-size atlas for the visible pool, regardless of total library size. */
export class CoverAtlas {
  readonly array: THREE.InstancedMesh;
  readonly selected: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshLambertMaterial>;
  private readonly atlasCanvas = document.createElement("canvas");
  private readonly selectedCanvas = document.createElement("canvas");
  private readonly tileCanvas = document.createElement("canvas");
  private readonly uploadCanvas = document.createElement("canvas");
  private readonly uploadTexture: THREE.Texture;
  private readonly atlas: THREE.CanvasTexture;
  private readonly selectedTexture: THREE.CanvasTexture;
  private readonly selectedReveal: CoverReveal;
  private readonly pendingImages = new Map<string, Promise<DecodedCoverImage | undefined>>();
  private readonly decodedImages = new Map<string, DecodedCoverImage | undefined>();
  private readonly decodeJobs = new Map<string, DecodeJob>();
  private readonly decodeQueue: DecodeJob[] = [];
  private readonly activeJobs = new Set<DecodeJob>();
  private readonly dirtySlots = new Set<number>();
  private readonly coverReady: THREE.InstancedBufferAttribute;
  private readonly coverTiles: THREE.InstancedBufferAttribute;
  // Instance IDs remain stable for picking and motion, but identical prints
  // share a physical tile. Only unreferenced tiles may be recycled.
  private readonly slotTiles: Int32Array;
  private readonly tileKeys: (string | undefined)[];
  private readonly keyTiles = new Map<string, number>();
  private readonly tileUsers: Set<number>[];
  private readonly reusableTiles: Set<number>;
  private readonly tileReady: Uint8Array;
  private gpuInitialized = false;
  private unpackState?: AtlasUnpackState;
  private uploadedBytes = 0;
  private uploadBatches = 0;
  private uploadedTiles = 0;
  private uploadCalls = 0;
  private peakDecodes = 0;
  private decodedPixels = 0;
  private readonly maxDecodeConcurrency = 3;
  private readonly maxDecodedPixels = 4 * 1024 * 1024;
  private readonly slotKeys: (string | undefined)[];
  private recordKeys = new WeakMap<ArchiveRecord, string>();
  private readonly snapshots = new WeakMap<THREE.Mesh, {
    canvas: HTMLCanvasElement; texture: THREE.CanvasTexture; revision: number; record?: ArchiveRecord; reveal: CoverReveal;
  }>();
  private selectedRecord?: ArchiveRecord;
  private selectedKey?: string;
  private generation = 0;
  private disposed = false;
  private readonly columns: number;
  private rows: number;
  private readonly maxRows: number;
  private readonly tileWidth: number;
  private readonly tileHeight: number;

  constructor(count: number, maxTextureSize: number, anisotropy: number, lighting?: MusicSelectionLighting) {
    // Keep the enlarged 612-slot shelf below an 8192px texture edge at the
    // existing 256px cover resolution; preserve smaller pools' original grid.
    this.columns = count > 512 ? 24 : 16;
    this.maxRows = Math.ceil(count / this.columns);
    // Reserve only a small working set. Repeated albums share physical tiles;
    // a large library does not imply that all 612 shelf slots need unique art.
    this.rows = Math.min(8, this.maxRows);
    this.tileWidth = Math.min(
      256,
      Math.floor(maxTextureSize / this.columns),
      Math.floor(maxTextureSize / this.maxRows),
    );
    this.tileHeight = this.tileWidth;
    this.atlasCanvas.width = this.columns * this.tileWidth;
    this.atlasCanvas.height = this.rows * this.tileHeight;
    this.tileCanvas.width = this.tileWidth;
    this.tileCanvas.height = this.tileHeight;
    this.uploadCanvas.width = this.tileWidth;
    this.uploadCanvas.height = this.tileHeight;
    // This CPU-only source is copied directly into a subregion of the atlas.
    // It must never be initialized as a separate GPU texture.
    this.uploadTexture = new THREE.Texture(this.uploadCanvas);
    this.uploadTexture.colorSpace = THREE.SRGBColorSpace;
    this.uploadTexture.generateMipmaps = false;
    this.selectedCanvas.width = COVER_PAINT_SIZE;
    this.selectedCanvas.height = COVER_PAINT_SIZE;
    this.slotKeys = Array(count);
    this.slotTiles = new Int32Array(count).fill(-1);
    // Use the already allocated grid's spare cells too; no larger texture.
    const capacity = this.columns * this.maxRows;
    this.tileKeys = Array(capacity);
    this.tileUsers = Array.from({ length: capacity }, () => new Set<number>());
    this.reusableTiles = new Set(Array.from({ length: capacity }, (_, i) => i));
    this.tileReady = new Uint8Array(capacity);
    this.atlas = new THREE.CanvasTexture(this.atlasCanvas);
    this.atlas.colorSpace = THREE.SRGBColorSpace;
    // No whole-atlas mip pyramid: independent transparent tile margins prevent bleed.
    this.atlas.generateMipmaps = false;
    this.atlas.minFilter = THREE.LinearFilter;
    // Atlas derivatives at steep shelf angles must not sample another tile.
    // Detailed selected art keeps anisotropic filtering on its own texture.
    this.atlas.anisotropy = 1;
    this.atlas.userData.maxAnisotropy = 1;
    this.selectedTexture = new THREE.CanvasTexture(this.selectedCanvas);
    this.selectedTexture.colorSpace = THREE.SRGBColorSpace;
    this.selectedTexture.anisotropy = Math.min(8, anisotropy);
    this.selectedTexture.userData.maxAnisotropy = 8;
    const geometry = new THREE.PlaneGeometry(
      COVER_SIZE.width,
      COVER_SIZE.height,
    ).translate(COVER_SIZE.x, COVER_SIZE.y, COVER_SIZE.z);
    const tileOffsets = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      tileOffsets.set(
        [
          (i % this.columns) / this.columns,
          1 - (Math.floor(i / this.columns) + 1) / this.rows,
          1 / this.columns,
          1 / this.rows,
        ],
        i * 4,
      );
    }
    this.coverTiles = new THREE.InstancedBufferAttribute(tileOffsets, 4);
    this.coverTiles.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute("coverTile", this.coverTiles);
    this.coverReady = new THREE.InstancedBufferAttribute(new Float32Array(count), 1);
    this.coverReady.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute("coverReady", this.coverReady);
    // Instances, selected art and snapshots use one matte diffuse material and
    // one moving light field; no ownership-specific brightness/scale switches.
    const makePrint = (texture: THREE.Texture) => {
      const print = createAlbumPrintMaterial(texture);
      const compile = print.onBeforeCompile;
      print.onBeforeCompile = (shader, renderer) => {
        compile.call(print, shader, renderer);
        lighting?.shadePrint(shader);
      };
      print.customProgramCacheKey = () => `album-diffuse-print-${Boolean(lighting)}-v4`;
      return print;
    };
    const material = makePrint(this.atlas);
    const compileAtlas = material.onBeforeCompile;
    material.onBeforeCompile = (shader, renderer) => {
      compileAtlas.call(material, shader, renderer);
      shader.vertexShader = "attribute vec4 coverTile;\nattribute float coverReady;\nvarying float vCoverReady;\nvarying vec4 vCoverTile;\n" + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace(
        "#include <uv_vertex>",
        "#include <uv_vertex>\nvCoverReady = coverReady;\nvCoverTile = coverTile;\nvMapUv = coverTile.xy + uv * coverTile.zw;",
      );
      shader.uniforms.coverAtlasTexel = this.atlas.userData.texel ??= { value: new THREE.Vector2(1 / this.atlasCanvas.width, 1 / this.atlasCanvas.height) };
      shader.fragmentShader = "varying float vCoverReady;\nvarying vec4 vCoverTile;\nuniform vec2 coverAtlasTexel;\n" + shader.fragmentShader;
      shader.fragmentShader = shader.fragmentShader.replace("#include <map_fragment>",
        "if (vCoverReady < 0.5) discard;\n" + THREE.ShaderChunk.map_fragment.replace("texture2D( map, vMapUv )", "texture2D( map, clamp(vMapUv, vCoverTile.xy + coverAtlasTexel * 0.5, vCoverTile.xy + vCoverTile.zw - coverAtlasTexel * 0.5) )"));
    };
    material.customProgramCacheKey = () => `album-diffuse-atlas-${Boolean(lighting)}-v4`;
    this.array = new THREE.InstancedMesh(geometry, material, count);
    this.array.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.array.frustumCulled = false;
    this.array.visible = false;
    this.array.name = "Album cover atlas";
    this.array.receiveShadow = true;
    this.selected = new THREE.Mesh(
      new THREE.PlaneGeometry(COVER_SIZE.width, COVER_SIZE.height).translate(
        COVER_SIZE.x,
        COVER_SIZE.y,
        COVER_SIZE.z,
      ),
      makePrint(this.selectedTexture),
    );
    this.selected.userData.albumCover = true;
    this.selected.visible = false;
    this.selected.name = "Selected album cover";
    this.selected.receiveShadow = true;
    this.selectedReveal = new CoverReveal(this.selected.material);
  }

  private cachedImage(url?: string) {
    if (!url || !this.decodedImages.has(url)) return undefined;
    const image = this.decodedImages.get(url);
    this.decodedImages.delete(url);
    this.decodedImages.set(url, image);
    return image;
  }

  private reserveTile(tile: number) {
    if (tile < this.columns * this.rows) return;
    const old = document.createElement('canvas');
    old.width = this.atlasCanvas.width; old.height = this.atlasCanvas.height;
    old.getContext('2d')!.drawImage(this.atlasCanvas, 0, 0);
    this.rows = Math.min(this.maxRows, Math.max(this.rows * 2, Math.ceil((tile + 1) / this.columns)));
    this.atlasCanvas.height = this.rows * this.tileHeight;
    this.atlasCanvas.getContext('2d')!.drawImage(old, 0, 0);
    old.width = old.height = 1;
    // Resizing a canvas does not resize immutable WebGL storage. Release the
    // old allocation and repopulate through the same bounded upload queue.
    this.atlas.dispose();
    this.gpuInitialized = false;
    this.atlas.needsUpdate = true;
    for (let i = 0; i < this.tileKeys.length; i++) {
      if (this.tileKeys[i] !== undefined) this.dirtySlots.add(i);
      this.tileReady[i] = 0;
    }
    for (let slot = 0; slot < this.slotTiles.length; slot++) {
      const resident = this.slotTiles[slot];
      if (resident < 0) continue;
      this.coverTiles.setXYZW(slot, (resident % this.columns) / this.columns,
        1 - (Math.floor(resident / this.columns) + 1) / this.rows, 1 / this.columns, 1 / this.rows);
      this.coverReady.setX(slot, 0);
    }
    this.coverTiles.needsUpdate = this.coverReady.needsUpdate = true;
    const uniform = this.atlas.userData.texel as { value: THREE.Vector2 } | undefined;
    uniform?.value.set(1 / this.atlasCanvas.width, 1 / this.atlasCanvas.height);
  }

  private loadImage(url?: string, priority = false) {
    if (!url) return Promise.resolve(undefined);
    if (this.disposed) return Promise.resolve(undefined);
    const size = priority ? COVER_PAINT_SIZE : this.tileWidth;
    if (this.decodedImages.has(url)) {
      const cached = this.cachedImage(url);
      if (!cached || cached.decodedSize >= Math.min(size, Math.max(cached.width, cached.height))) return Promise.resolve(cached);
    }
    let pending = this.pendingImages.get(url);
    if (pending) {
      const job = this.decodeJobs.get(url);
      if (job && priority) {
        job.size = Math.max(job.size, size);
        const index = this.decodeQueue.indexOf(job);
        if (index > 0) { this.decodeQueue.splice(index, 1); this.decodeQueue.unshift(job); }
      }
      return pending;
    }
    let resolve!: DecodeJob["resolve"];
    pending = new Promise<DecodedCoverImage | undefined>((done) => { resolve = done; });
    const job: DecodeJob = { url, generation: this.generation, size, resolve };
    this.pendingImages.set(url, pending);
    this.decodeJobs.set(url, job);
    if (priority) this.decodeQueue.unshift(job);
    else this.decodeQueue.push(job);
    this.pumpDecodes();
    return pending;
  }

  private pumpDecodes() {
    while (!this.disposed && this.activeJobs.size < this.maxDecodeConcurrency && this.decodeQueue.length) {
      const job = this.decodeQueue.shift()!;
      const image = new Image();
      job.image = image;
      this.activeJobs.add(job);
      this.peakDecodes = Math.max(this.peakDecodes, this.activeJobs.size);
      image.crossOrigin = "anonymous";
      let cooked = cookedTextureSource(job.url, job.size);
      image.src = cooked.url;
      void image.decode()
        .catch(async () => {
          // A damaged/missing cooked asset still has its preserved source.
          if (cooked.url === job.url || this.disposed || job.generation !== this.generation) throw new Error("Cover unavailable");
          cooked = { url: job.url };
          image.src = job.url; await image.decode();
        })
        .then(async () => {
          if (this.disposed || job.generation !== this.generation) return undefined;
          // A foreground selection can upgrade a running thumbnail request.
          const upgraded = cookedTextureSource(job.url, job.size);
          if (cooked.width && image.naturalWidth < Math.min(job.size, cooked.width) && upgraded.url !== cooked.url) {
            image.src = upgraded.url;
            try { await image.decode(); cooked = upgraded; }
            catch { image.src = job.url; await image.decode(); cooked = { url: job.url }; }
          }
          if (this.disposed || job.generation !== this.generation) return undefined;
          // Background slots only retain tile-sized thumbnails. Priority can
          // upgrade an in-flight source before its canvas is produced.
          const width = cooked.width ?? image.naturalWidth,
            height = cooked.height ?? image.naturalHeight;
          const scale = Math.min(1, job.size / Math.max(image.naturalWidth, image.naturalHeight));
          const source = document.createElement("canvas");
          source.width = Math.max(1, Math.round(image.naturalWidth * scale));
          source.height = Math.max(1, Math.round(image.naturalHeight * scale));
          source
            .getContext("2d")!
            .drawImage(image, 0, 0, source.width, source.height);
          return { source, width, height, decodedSize: Math.max(source.width, source.height), pixels: source.width * source.height };
        })
        .catch(() => undefined)
        .then((decoded) => {
          image.src = "";
          this.activeJobs.delete(job);
          if (!this.disposed && job.generation === this.generation) {
            this.decodedPixels -= this.decodedImages.get(job.url)?.pixels ?? 0;
            this.decodedImages.delete(job.url);
            this.decodedImages.set(job.url, decoded);
            this.decodedPixels += decoded?.pixels ?? 0;
            while (this.decodedImages.size > 48 || this.decodedPixels > this.maxDecodedPixels) {
              const first = this.decodedImages.keys().next().value!;
              this.decodedPixels -= this.decodedImages.get(first)?.pixels ?? 0;
              this.decodedImages.delete(first);
            }
          }
          if (this.decodeJobs.get(job.url) === job) {
            this.decodeJobs.delete(job.url);
            this.pendingImages.delete(job.url);
          }
          job.resolve(this.disposed || job.generation !== this.generation ? undefined : decoded);
          this.pumpDecodes();
        });
    }
  }

  private recordKey(record: ArchiveRecord | undefined) {
    // Description/metadata refreshes replace record objects without changing
    // their print. Cache only the visual identity, not the object reference.
    let key = record ? this.recordKeys.get(record) : "";
    if (record && key === undefined) {
      key = JSON.stringify([record.id, getAlbumCoverUrl(record.album), record.title, record.album?.artist]);
      this.recordKeys.set(record, key);
    }
    return key!;
  }

  private copyCover(canvas: HTMLCanvasElement, key: string) {
    const selected = this.selectedKey === key && canvas !== this.selectedCanvas;
    const slot = selected ? -1 : this.keyTiles.get(key) ?? -1;
    if (!selected && slot < 0) return false;
    const context = canvas.getContext("2d")!;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, canvas.width, canvas.height);
    // Copy the whole painted tile, including its UV inset, exactly once.
    if (selected) context.drawImage(this.selectedCanvas, 0, 0, canvas.width, canvas.height);
    else context.drawImage(
      this.atlasCanvas,
      (slot % this.columns) * this.tileWidth,
      Math.floor(slot / this.columns) * this.tileHeight,
      this.tileWidth, this.tileHeight,
      0, 0, canvas.width, canvas.height,
    );
    return true;
  }

  setSlot(slot: number, record: ArchiveRecord | undefined) {
    const key = this.recordKey(record);
    if (this.slotKeys[slot] === key) return;
    const previous = this.slotTiles[slot];
    if (previous >= 0) {
      this.tileUsers[previous].delete(slot);
      if (!this.tileUsers[previous].size) this.reusableTiles.add(previous);
    }
    let tile = this.keyTiles.get(key);
    const resident = tile !== undefined;
    if (tile === undefined) {
      // There cannot be more active print identities than instance slots.
      // LRU order of unused tiles keeps recently viewed albums warm as well.
      // Recycle unused resident storage before expanding the atlas just to
      // keep old, invisible albums warm.
      for (const candidate of this.reusableTiles) {
        if (candidate < this.columns * this.rows) { tile = candidate; break; }
      }
      tile ??= this.reusableTiles.values().next().value!;
      this.reserveTile(tile);
      const oldKey = this.tileKeys[tile];
      if (oldKey !== undefined) this.keyTiles.delete(oldKey);
      this.tileKeys[tile] = key;
      this.keyTiles.set(key, tile);
      this.tileReady[tile] = 0;
    }
    this.reusableTiles.delete(tile);
    this.tileUsers[tile].add(slot);
    this.slotTiles[slot] = tile;
    this.slotKeys[slot] = key;
    this.coverTiles.setXYZW(slot, (tile % this.columns) / this.columns,
      1 - (Math.floor(tile / this.columns) + 1) / this.rows, 1 / this.columns, 1 / this.rows);
    this.coverTiles.needsUpdate = true;
    // A cached print can be shown immediately. A newly assigned physical tile
    // remains hidden until uploaded, so recycled instances never show old art.
    this.coverReady.setX(slot, this.tileReady[tile]);
    this.coverReady.needsUpdate = true;
    if (resident) return;
    const image = this.cachedImage(getAlbumCoverUrl(record?.album));
    if (image) paintCover(this.tileCanvas, record, image);
    else if (this.selectedKey === key) this.copyCover(this.tileCanvas, key);
    else paintCover(this.tileCanvas, record);
    const generation = this.generation;
    const draw = (image?: CoverImage) => {
      if (this.disposed || generation !== this.generation || this.tileKeys[tile] !== key) return;
      if (image) paintCover(this.tileCanvas, record, image);
      const x = (tile % this.columns) * this.tileWidth,
        y = Math.floor(tile / this.columns) * this.tileHeight;
      const context = this.atlasCanvas.getContext("2d")!;
      context.clearRect(x, y, this.tileWidth, this.tileHeight);
      context.drawImage(this.tileCanvas, x, y);
      this.dirtySlots.add(tile);
    };
    draw();
    if (!image) void this.loadImage(getAlbumCoverUrl(record?.album)).then((loaded) => {
      if (loaded) draw(loaded);
    });
  }

  private loadDisplayImage(url: string | undefined, record?: ArchiveRecord) {
    const request = this.loadImage(url, true);
    if (!record?.displayCoverFallback || url === record.displayCoverFallback) return request;
    return request.then(image => image ?? this.loadImage(record.displayCoverFallback, true));
  }

  async select(record: ArchiveRecord | undefined, returning?: THREE.Mesh) {
    this.selectedRecord = record;
    const key = this.recordKey(record);
    if (this.selectedKey === key) return;
    this.selectedReveal.reset();
    const snapshot = returning && this.snapshots.get(returning);
    if (snapshot && snapshot.record === record)
      this.selectedReveal.copyFrom(snapshot.reveal, this.selectedTexture.anisotropy);
    const generation = this.generation;
    const coverUrl = getAlbumCoverUrl(record?.album);
    const cached = this.cachedImage(coverUrl);
    if (!coverUrl || (this.decodedImages.has(coverUrl) && !cached)) paintCover(this.selectedCanvas, record);
    else if (cached) paintCover(this.selectedCanvas, record, cached);
    else if (!this.copyCover(this.selectedCanvas, key)) paintCover(this.selectedCanvas, record);
    this.selectedKey = key;
    this.selectedTexture.needsUpdate = true;
    if (cached && cached.decodedSize >= Math.min(COVER_PAINT_SIZE, Math.max(cached.width, cached.height))) return;
    const image = await this.loadDisplayImage(coverUrl, record);
    if (
      this.disposed ||
      generation !== this.generation ||
      this.selectedKey !== key
    )
      return;
    // Failed loads also repaint from the full 800px generated source; they
    // must not leave enlarged text copied from a temporary 256px shelf tile.
    paintCover(this.selectedCanvas, record, image);
    this.selectedTexture.needsUpdate = true;
  }

  snapshot(mesh: THREE.Mesh, record = this.selectedRecord) {
    let snapshot = this.snapshots.get(mesh);
    if (!snapshot) {
      const canvas = document.createElement("canvas");
      canvas.width = this.selectedCanvas.width;
      canvas.height = this.selectedCanvas.height;
      const texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      mesh.material = this.selected.material.clone();
      mesh.material.onBeforeCompile = this.selectedReveal.baseCompile;
      mesh.material.customProgramCacheKey = this.selectedReveal.baseCacheKey;
      (mesh.material as THREE.MeshLambertMaterial).map = texture;
      snapshot = { canvas, texture, revision: 0, reveal: new CoverReveal(mesh.material as THREE.MeshLambertMaterial) };
      this.snapshots.set(mesh, snapshot);
    }
    const { canvas, texture } = snapshot;
    snapshot.record = record;
    const revision = ++snapshot.revision;
    const generation = this.generation;
    const context = canvas.getContext("2d")!;
    context.clearRect(0, 0, canvas.width, canvas.height);
    if (record === this.selectedRecord) context.drawImage(this.selectedCanvas, 0, 0);
    else paintCover(canvas, record, this.cachedImage(getAlbumCoverUrl(record?.album)));
    texture.anisotropy = this.selectedTexture.anisotropy;
    texture.needsUpdate = true;
    if (record === this.selectedRecord) snapshot.reveal.copyFrom(this.selectedReveal, texture.anisotropy);
    // A refreshed returning copy keeps its own original and extraction progress.
    if (snapshot.reveal.progress > 0 && usesDefaultCovers()) this.requestReveal(snapshot.reveal, record);
    mesh.userData.coverDisposed = false;
    void this.loadDisplayImage(getAlbumCoverUrl(record?.album), record).then((image) => {
      if (mesh.userData.coverDisposed || this.disposed || generation !== this.generation || snapshot.revision !== revision) return;
      // A pending original may fail after the selection has moved on. Its
      // returning snapshot still needs the full 800px generated source.
      paintCover(canvas, record, image);
      texture.needsUpdate = true;
    });
  }

  refreshSnapshot(mesh: THREE.Mesh) {
    const snapshot = this.snapshots.get(mesh);
    if (snapshot) {
      snapshot.reveal.revision++;
      snapshot.reveal.requested = false;
      this.snapshot(mesh, snapshot.record);
    }
  }

  private requestReveal(reveal: CoverReveal, record: ArchiveRecord | undefined) {
    if (reveal.requested || !record) return;
    reveal.requested = true;
    const generation = this.generation, revision = reveal.revision;
    const url = record.album?.coverUrl;
    if (!url) {
      reveal.paint(record, undefined, this.selectedTexture.anisotropy);
      return;
    }
    void this.loadDisplayImage(url, record).then(image => {
      if (this.disposed || reveal.disposed || generation !== this.generation || revision !== reveal.revision) return;
      reveal.paint(record, image, this.selectedTexture.anisotropy);
    });
  }

  prepareReveal() {
    if (usesDefaultCovers()) this.requestReveal(this.selectedReveal, this.selectedRecord);
  }

  updateReveal(progress: number, dt: number) {
    if (!usesDefaultCovers()) progress = 0;
    if (progress > 0) this.prepareReveal();
    this.selectedReveal.setAnisotropy(this.selectedTexture.anisotropy);
    this.selectedReveal.update(progress, dt);
  }

  updateSnapshotReveal(mesh: THREE.Mesh, progress: number, dt: number) {
    const snapshot = this.snapshots.get(mesh);
    if (!snapshot) return;
    if (!usesDefaultCovers()) progress = 0;
    if (progress > 0) this.requestReveal(snapshot.reveal, snapshot.record);
    snapshot.reveal.setAnisotropy(this.selectedTexture.anisotropy);
    snapshot.reveal.update(progress, dt);
  }

  /** Up to 8 × 256² RGBA pixels (2 MiB). Adjacent tiles share one upload:
   * Three's copy call synchronously reads five unpack states, so issuing it
   * separately for every tile stalls navigation behind the GPU repeatedly. */
  flushUploads(renderer: THREE.WebGLRenderer, maxTiles = 8) {
    if (this.disposed || !this.dirtySlots.size) return 0;
    if (!this.gpuInitialized) {
      // Allocate immutable GPU storage without synchronously uploading the
      // full CPU canvas. Subsequent slots arrive through texSubImage2D copies.
      this.atlas.source.dataReady = false;
      try { renderer.initTexture(this.atlas); this.gpuInitialized = true; }
      finally { this.atlas.source.dataReady = true; }
    }
    const destination = new THREE.Vector2();
    let uploaded = 0;
    const limit = Math.max(1, Math.min(64, Math.floor(maxTiles) || 8));
    const pending = [...this.dirtySlots].sort((a, b) => a - b);
    const batch = beginAtlasUpload(renderer, this.atlas, this.unpackState);
    if (batch) this.unpackState = batch.state;
    try {
      for (let next = 0; next < pending.length && uploaded < limit;) {
        const first = pending[next++];
        const row = Math.floor(first / this.columns);
        let last = first;
        // A span may include clean tiles, which are copied from the same atlas.
        // Count their bytes too; the existing upload budget is never exceeded.
        while (next < pending.length && Math.floor(pending[next] / this.columns) === row &&
          pending[next] - first + 1 <= limit - uploaded) last = pending[next++];
        const tiles = last - first + 1;
        const x = (first % this.columns) * this.tileWidth;
        const y = row * this.tileHeight;
        const width = tiles * this.tileWidth;
        if (this.uploadCanvas.width !== width) this.uploadCanvas.width = width;
        const context = this.uploadCanvas.getContext("2d")!;
        context.clearRect(0, 0, width, this.tileHeight);
        context.drawImage(this.atlasCanvas, x, y, width, this.tileHeight, 0, 0, width, this.tileHeight);
        // Canvas rows run downwards; WebGL destination origins run upwards.
        destination.set(x, this.atlasCanvas.height - y - this.tileHeight);
        if (batch) batch.copy(this.uploadCanvas, destination.x, destination.y);
        else renderer.copyTextureToTexture(this.uploadTexture, this.atlas, null, destination);
        this.uploadCalls++;
        for (let slot = first; slot <= last; slot++) {
          if (!this.dirtySlots.delete(slot)) continue;
          this.tileReady[slot] = 1;
          for (const user of this.tileUsers[slot]) this.coverReady.setX(user, 1);
        }
        this.uploadedBytes += width * this.tileHeight * 4;
        this.uploadedTiles += tiles;
        uploaded += tiles;
      }
    } finally { batch?.end(); }
    if (uploaded) { this.coverReady.needsUpdate = true; this.uploadBatches++; }
    return uploaded;
  }

  /** Bounded wait for the currently visible requests; no whole-library preload. */
  async prepareVisible(timeoutMs = 1200) {
    const pending = [...this.pendingImages.values()];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settled = !pending.length || await Promise.race([
      Promise.all(pending).then(() => true),
      new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), Math.max(0, Math.min(3000, timeoutMs))); }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
    return { settled, ...this.getStats() };
  }

  getStats() {
    return {
      atlasWidth: this.atlasCanvas.width, atlasHeight: this.atlasCanvas.height,
      atlasBytes: this.atlasCanvas.width * this.atlasCanvas.height * 4,
      atlasCapacity: this.columns * this.rows, atlasMaxCapacity: this.columns * this.maxRows,
      tileWidth: this.tileWidth, tileHeight: this.tileHeight,
      activeDecodes: this.activeJobs.size, queuedDecodes: this.decodeQueue.length,
      pendingImages: this.pendingImages.size, peakDecodes: this.peakDecodes,
      cachedImages: this.decodedImages.size, cachedBytes: this.decodedPixels * 4,
      dirtyTiles: this.dirtySlots.size, uploadedTiles: this.uploadedTiles,
      uploadedBytes: this.uploadedBytes, uploadBatches: this.uploadBatches,
      uploadCalls: this.uploadCalls, residentTiles: this.keyTiles.size,
      gpuInitialized: this.gpuInitialized,
    };
  }

  private cancelDecodes() {
    for (const job of this.decodeQueue.splice(0)) job.resolve(undefined);
    for (const job of this.activeJobs) { job.resolve(undefined); if (job.image) job.image.src = ""; }
    this.pendingImages.clear();
    this.decodeJobs.clear();
    this.decodedImages.clear();
    this.decodedPixels = 0;
  }

  reset() {
    this.generation++;
    this.selectedReveal.reset();
    this.recordKeys = new WeakMap();
    this.slotKeys.fill(undefined);
    this.slotTiles.fill(-1);
    this.tileKeys.fill(undefined);
    this.keyTiles.clear();
    this.tileReady.fill(0);
    this.reusableTiles.clear();
    for (let tile = 0; tile < this.tileUsers.length; tile++) {
      this.tileUsers[tile].clear();
      this.reusableTiles.add(tile);
    }
    this.selectedRecord = undefined;
    this.selectedKey = undefined;
    this.cancelDecodes();
    if (this.rows > Math.min(8, this.maxRows)) {
      this.rows = Math.min(8, this.maxRows);
      this.atlasCanvas.height = this.rows * this.tileHeight;
      this.atlas.dispose(); this.gpuInitialized = false; this.atlas.needsUpdate = true;
      const uniform = this.atlas.userData.texel as { value: THREE.Vector2 } | undefined;
      uniform?.value.set(1 / this.atlasCanvas.width, 1 / this.atlasCanvas.height);
    }
    this.dirtySlots.clear();
    this.coverReady.array.fill(0);
    this.coverReady.needsUpdate = true;
  }
  dispose() {
    this.disposed = true;
    this.generation++;
    this.unpackState?.release();
    this.unpackState = undefined;
    this.cancelDecodes();
    this.dirtySlots.clear();
    this.uploadTexture.dispose();
    this.atlas.dispose();
    this.selectedTexture.dispose();
    this.array.geometry.dispose();
    (this.array.material as THREE.Material).dispose();
    this.selected.geometry.dispose();
    this.selected.material.dispose();
    this.atlasCanvas.width = this.atlasCanvas.height = 1;
    this.selectedCanvas.width = this.selectedCanvas.height = 1;
    this.tileCanvas.width = this.tileCanvas.height = 1;
    this.uploadCanvas.width = this.uploadCanvas.height = 1;
  }
}
