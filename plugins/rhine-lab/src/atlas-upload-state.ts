/** Track writes on this renderer's own context. Reading unpack state back
 * from the GPU on every frame serializes rendering and texture transfers. */
export type AtlasUnpackState = {
  parameters: number[];
  values: Map<number, number | boolean>;
  release(): void;
};
type Entry = Omit<AtlasUnpackState, "release"> & {
  users: number;
  original: WebGL2RenderingContext["pixelStorei"];
  tracked: WebGL2RenderingContext["pixelStorei"];
};
const contexts = new WeakMap<WebGL2RenderingContext, Entry>();

export function trackAtlasUnpack(gl: WebGL2RenderingContext): AtlasUnpackState {
  let entry = contexts.get(gl);
  if (!entry) {
    const parameters = [gl.UNPACK_ROW_LENGTH, gl.UNPACK_IMAGE_HEIGHT, gl.UNPACK_SKIP_PIXELS,
      gl.UNPACK_SKIP_ROWS, gl.UNPACK_SKIP_IMAGES, gl.UNPACK_FLIP_Y_WEBGL,
      gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, gl.UNPACK_ALIGNMENT];
    // One initial read during loading, then observe every pixelStorei write,
    // including Three's uploads and callers using nondefault unpack settings.
    const values = new Map<number, number | boolean>(parameters.map(p => [p, gl.getParameter(p)]));
    const original = gl.pixelStorei;
    const tracked: typeof original = function(parameter, value) {
      original.call(gl, parameter, value);
      if (!values.has(parameter)) return;
      if (parameter === gl.UNPACK_FLIP_Y_WEBGL || parameter === gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL) {
        values.set(parameter, Boolean(value));
      } else {
        const integer = Number(value) | 0;
        // Invalid GL writes leave the old state intact.
        if (parameter === gl.UNPACK_ALIGNMENT ? [1, 2, 4, 8].includes(integer) : integer >= 0)
          values.set(parameter, integer);
      }
    };
    gl.pixelStorei = tracked;
    entry = { parameters, values, original, tracked, users: 0 };
    contexts.set(gl, entry);
  }
  entry.users++;
  const owned = entry;
  let released = false;
  return { parameters: owned.parameters, values: owned.values, release() {
    if (released) return;
    released = true;
    if (--owned.users === 0) {
      if (gl.pixelStorei === owned.tracked) gl.pixelStorei = owned.original;
      contexts.delete(gl);
    }
  } };
}
