import manifest from "./cooked-render-assets.json" with { type: "json" };
import { assetUrl } from "./asset-url.ts";

/** Static assets have prefiltered mip sources; user artwork stays on the bounded
 * runtime decoder. Match exact resolved URLs so foreign/query URLs are untouched. */
export function cookedTextureSource(url: string, size: number) {
  const entry = Object.entries(manifest.textures).find(
    ([path]) => assetUrl(path) === url,
  )?.[1];
  if (!entry) return { url };
  const level = entry.levels[size <= 256 ? "256" : "1024"];
  return {
    url: assetUrl(`cooked/${level.file}?v=${level.sha256.slice(0, 12)}`),
    width: entry.width,
    height: entry.height,
  };
}
