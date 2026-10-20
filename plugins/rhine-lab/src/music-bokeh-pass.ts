import { Camera, Scene, ShaderMaterial, Texture, WebGLRenderer, WebGLRenderTarget } from "three";
import { BokehPass, type BokehPassParameters } from "three/addons/postprocessing/BokehPass.js";
import { FullScreenQuad } from "three/addons/postprocessing/Pass.js";
import type { SSAOPass } from "three/addons/postprocessing/SSAOPass.js";

/** Keep Three's bokeh filter, sharing the current frame's full-resolution AO
 * depth instead of drawing all album geometry a second time for the same depth. */
export class MusicBokehPass extends BokehPass {
  private readonly sharedMaterial: ShaderMaterial;
  private readonly sharedQuad: FullScreenQuad;
  private readonly packedDepth: Texture;
  sharedDepth = false;

  constructor(scene: Scene, camera: Camera, params: BokehPassParameters,
    private readonly source: () => SSAOPass | undefined) {
    super(scene, camera, params);
    const uniforms = this.uniforms as Record<string, { value: unknown }>;
    this.packedDepth = uniforms.tDepth.value as Texture;
    this.sharedMaterial = this.materialBokeh.clone();
    this.sharedMaterial.uniforms = this.materialBokeh.uniforms;
    // BokehShader already supports native depth; the sampling kernel, aperture,
    // focus, max blur and color resolution remain unchanged.
    this.sharedMaterial.defines.DEPTH_PACKING = 0;
    this.sharedQuad = new FullScreenQuad(this.sharedMaterial);
  }

  override render(renderer: WebGLRenderer, writeBuffer: WebGLRenderTarget,
    readBuffer: WebGLRenderTarget, deltaTime: number, maskActive: boolean) {
    const source = this.source();
    const target = source?.normalRenderTarget;
    this.sharedDepth = Boolean(source?.enabled && target?.depthTexture &&
      // Three retains fractional target sizes at 125%/150% display scaling,
      // while WebGL allocates integer pixels. Compare the actual raster sizes.
      target.width === Math.floor(readBuffer.width) && target.height === Math.floor(readBuffer.height));
    const uniforms = this.uniforms as Record<string, { value: unknown }>;
    if (!this.sharedDepth) {
      // AO may be disabled or explicitly set to a smaller resolution. Preserve
      // the original full-resolution depth path for those user configurations.
      uniforms.tDepth.value = this.packedDepth;
      super.render(renderer, writeBuffer, readBuffer, deltaTime, maskActive);
      return;
    }
    uniforms.tDepth.value = target!.depthTexture;
    uniforms.tColor.value = readBuffer.texture;
    uniforms.nearClip.value = (this.camera as Camera & { near: number }).near;
    uniforms.farClip.value = (this.camera as Camera & { far: number }).far;
    const autoClear = renderer.autoClear;
    renderer.autoClear = false;
    try {
      renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
      renderer.clear();
      this.sharedQuad.render(renderer);
    } finally { renderer.autoClear = autoClear; }
  }

  override dispose() {
    this.sharedQuad.dispose();
    this.sharedMaterial.dispose();
    super.dispose();
  }
}
