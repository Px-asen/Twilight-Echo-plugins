import {
  CustomBlending,
  RedFormat,
  type WebGLRenderer,
  type WebGLRenderTarget,
} from "three";
import { SSAOPass } from "three/addons/postprocessing/SSAOPass.js";
import { FullScreenQuad } from "three/addons/postprocessing/Pass.js";
import { GeometryStateCache } from "./render-cache.ts";

/** Cache only view-space occlusion/depth, never the lit color image. Animated
 * glass, themes and the moving light ribbon still shade every rendered frame. */
export class CachedOcclusionPass extends SSAOPass {
  private readonly state = new GeometryStateCache();
  private readonly cachedQuad = new FullScreenQuad(this.copyMaterial);
  private valid = false;
  private canvas?: HTMLCanvasElement;
  private readonly restored = () => this.invalidate();
  cacheEnabled = true;
  readonly stats = { hits: 0, misses: 0 };
  private settings = "";
  constructor(...args: ConstructorParameters<typeof SSAOPass>) {
    super(...args);
    // These fullscreen filters never read or write depth. The shared normal
    // target remains the sole full-resolution geometry/depth allocation.
    this.ssaoRenderTarget.depthBuffer = false;
    this.blurRenderTarget.depthBuffer = false;
    // Occlusion is a scalar. Retain 16-bit precision while avoiding four
    // identical color channels in each full-screen AO/blur texture.
    this.ssaoRenderTarget.texture.format = RedFormat;
    this.blurRenderTarget.texture.format = RedFormat;
    this.copyMaterial.uniforms.copyOcclusion = { value: 1 };
    this.copyMaterial.fragmentShader = 'uniform float copyOcclusion;\n' +
      this.copyMaterial.fragmentShader.replace('vec4 texel = texture2D( tDiffuse, vUv );',
        'vec4 texel = texture2D( tDiffuse, vUv );\nif (copyOcclusion > 0.5) texel = vec4(vec3(texel.r), 1.0);');
    // Keep the output statement intact: the music scene softens this output
    // for translucent cases. Replacing it here silently bypassed that look.
  }
  invalidate() {
    this.valid = false;
  }
  override setSize(width: number, height: number) {
    super.setSize(width, height);
    this.invalidate();
  }
  override render(
    renderer: WebGLRenderer,
    write: WebGLRenderTarget,
    read: WebGLRenderTarget,
    dt: number,
    mask: boolean,
  ) {
    if (this.canvas !== renderer.domElement) {
      this.canvas?.removeEventListener("webglcontextrestored", this.restored);
      this.canvas = renderer.domElement;
      this.canvas.addEventListener("webglcontextrestored", this.restored);
      this.invalidate();
    }
    const settings = `${this.kernelRadius}/${this.minDistance}/${this.maxDistance}/${this.output}`;
    this.copyMaterial.uniforms.copyOcclusion.value = this.output === SSAOPass.OUTPUT.Normal ? 0 : 1;
    const changed = this.state.changed(this.scene, this.camera);
    if (
      !this.cacheEnabled ||
      !this.valid ||
      changed ||
      settings !== this.settings ||
      this.output !== SSAOPass.OUTPUT.Default
    ) {
      this.valid = false;
      // SSAOPass only updates these on resize; the archive animates its lens.
      this.ssaoMaterial.uniforms.cameraProjectionMatrix.value.copy(
        this.camera.projectionMatrix,
      );
      this.ssaoMaterial.uniforms.cameraInverseProjectionMatrix.value.copy(
        this.camera.projectionMatrixInverse,
      );
      super.render(renderer, write, read, dt, mask);
      this.valid = true;
      this.settings = settings;
      this.stats.misses++;
      return;
    }
    this.stats.hits++;
    this.copyMaterial.uniforms.tDiffuse.value = this.blurRenderTarget.texture;
    this.copyMaterial.blending = CustomBlending;
    const autoClear = renderer.autoClear;
    try {
      renderer.autoClear = false;
      renderer.setRenderTarget(this.renderToScreen ? null : read);
      this.cachedQuad.render(renderer);
    } finally {
      renderer.autoClear = autoClear;
    }
  }
  override dispose() {
    this.canvas?.removeEventListener("webglcontextrestored", this.restored);
    this.cachedQuad.dispose();
    super.dispose();
    this.noiseTexture.dispose();
    this.ssaoMaterial.dispose();
  }
}
