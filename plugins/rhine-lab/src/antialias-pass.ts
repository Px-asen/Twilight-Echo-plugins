import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';

/** Runs after tone mapping, on the picture actually sent to the screen. The
 * canvas' MSAA cannot antialias geometry drawn into a non-MSAA composer target. */
export class LightAntialiasPass extends ShaderPass {
  constructor() { super(FXAAShader); this.enabled = false; }
  override setSize(width: number, height: number) {
    this.uniforms.resolution.value.set(1 / Math.max(1, Math.floor(width)), 1 / Math.max(1, Math.floor(height)));
  }
}

/** Release large SMAA targets when changing to a lighter mode. */
export class OptionalSMAAPass extends SMAAPass {
  override setSize(width: number, height: number) {
    super.setSize(this.enabled ? width : 1, this.enabled ? height : 1);
  }
}
