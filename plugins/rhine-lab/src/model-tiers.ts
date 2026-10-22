/** Projected maximum case span in render pixels. Hysteresis keeps camera easing
 * from alternating meshes at a boundary; extracted albums use full geometry. */
export function modelTier(
  pixels: number,
  previous: number,
  full = false,
): number {
  if (full) return 0;
  if ((previous === 0 && pixels >= 900) || pixels > 1050) return 0;
  if ((previous === 2 && pixels < 285) || pixels < 240) return 2;
  return 1;
}
