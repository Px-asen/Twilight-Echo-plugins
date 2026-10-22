import { MeshDepthMaterial, type Mesh, type Object3D, type WebGLRenderer, type WebGLRenderTarget } from 'three';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';

/** Resolve the nearest glass surface with a cheap depth shader before shading
 * the packed shelf. Three's separate opaque refraction capture keeps its own
 * depth, so paper behind the lid is still available to physical transmission. */
export class GlassRenderPass extends RenderPass {
  prepassEnabled = true;
  private readonly depth = new MeshDepthMaterial({ colorWrite: false });
  private readonly hidden: Object3D[] = [];

  override render(renderer: WebGLRenderer, write: WebGLRenderTarget, read: WebGLRenderTarget,
    dt: number, mask: boolean) {
    if (!this.prepassEnabled || this.scene.overrideMaterial) {
      super.render(renderer, write, read, dt, mask);
      return;
    }
    const autoClear = renderer.autoClear, autoDepth = renderer.autoClearDepth;
    const background = this.scene.background, override = this.scene.overrideMaterial;
    this.scene.traverseVisible(object => {
      const mesh = object as Mesh;
      if (!(mesh.isMesh || (object as Object3D & {isPoints?:boolean}).isPoints)) return;
      const materials = mesh.isMesh ? (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) : [];
      if (!materials.some(m => m.visible && 'transmission' in m && Number(m.transmission) > 0 && m.depthWrite && !m.transparent)) {
        this.hidden.push(object); object.visible = false;
      }
    });
    try {
      renderer.autoClear = false;
      renderer.setRenderTarget(this.renderToScreen ? null : read);
      renderer.clearDepth();
      this.scene.background = null;
      this.scene.overrideMaterial = this.depth;
      renderer.render(this.scene, this.camera);
    } finally {
      this.scene.overrideMaterial = override;
      this.scene.background = background;
      for (const object of this.hidden) object.visible = true;
      this.hidden.length = 0;
      renderer.autoClear = autoClear;
    }
    try {
      renderer.autoClearDepth = false;
      super.render(renderer, write, read, dt, mask);
    } finally { renderer.autoClearDepth = autoDepth; }
  }
  override dispose() { this.depth.dispose(); }
}
