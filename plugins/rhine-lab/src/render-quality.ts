import { normalizeFrameRate, type FrameRate } from "./frame-limiter.ts";

/** Rendering controls are independent of lighting, materials and animation. */
export type RenderQuality = {
  frameRate: FrameRate;
  modelDetail: "auto" | "full";
  scale: number;
  pixelRatio: number;
  antialias: "off" | "fxaa" | "smaa";
  shadows: number;
  aoSamples: number;
  aoResolution: number;
  depthOfField: number;
  transmission: number;
  anisotropy: number;
};

export const qualityPresets = {
  performance: {
    frameRate: 60,
    modelDetail: "auto",
    scale: 80,
    pixelRatio: 1,
    antialias: "fxaa",
    shadows: 1024,
    aoSamples: 0,
    aoResolution: 0.5,
    depthOfField: 0,
    transmission: 0.5,
    anisotropy: 4,
  },
  original: {
    frameRate: 60,
    modelDetail: "full",
    scale: 100,
    pixelRatio: 1.5,
    antialias: "off",
    shadows: 2048,
    aoSamples: 32,
    aoResolution: 1,
    depthOfField: 100,
    transmission: 1,
    anisotropy: 16,
  },
  high: {
    frameRate: 60,
    modelDetail: "full",
    scale: 125,
    pixelRatio: 2,
    antialias: "smaa",
    shadows: 4096,
    aoSamples: 32,
    aoResolution: 1,
    depthOfField: 100,
    transmission: 1,
    anisotropy: 16,
  },
  ultra: {
    frameRate: 60,
    modelDetail: "full",
    scale: 150,
    pixelRatio: 2,
    antialias: "smaa",
    shadows: 4096,
    aoSamples: 64,
    aoResolution: 1,
    depthOfField: 100,
    transmission: 1,
    anisotropy: 16,
  },
} as const satisfies Record<string, RenderQuality>;
export type QualityPreset = keyof typeof qualityPresets;
export const presetLabels: Record<QualityPreset, string> = {
  performance: "低需求性能版",
  original: "原画质优化版",
  high: "高",
  ultra: "极高",
};

export function qualityDescription(quality: RenderQuality): string {
  const preset = matchingPreset(quality);
  if (preset === "performance")
    return "低需求性能版：降低画面清晰度、模型细节和透明效果，关闭景深与接缝阴影；功能和面板保持完整。帧率独立设置，可选 30 FPS 进一步降低负载。";
  if (preset === "original")
    return "原画质优化版：保留原版清晰度、完整模型、光影和景深。";
  return preset === "custom" ? "自定义画质：按下方设置渲染，帧率独立设置。" : "提高画面精细度，显卡和内存需求也会增加。";
}

const member = <T>(value: unknown, choices: readonly T[], fallback: T): T =>
  choices.includes(value as T) ? (value as T) : fallback;
const range = (
  value: unknown,
  min: number,
  max: number,
  step: number,
  fallback: number,
) =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, Math.round(value / step) * step))
    : fallback;

export function normalizeQuality(
  value: unknown,
  legacyHigh = true,
): RenderQuality {
  const base = qualityPresets.original;
  const v =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  // Older low quality retained full resolution, shadows and transmission.
  const fallback = legacyHigh
    ? base
    : { ...base, pixelRatio: 1, aoSamples: 0, depthOfField: 0 };
  return {
    frameRate: normalizeFrameRate(v.frameRate),
    modelDetail: member(v.modelDetail, ["auto", "full"] as const, fallback.modelDetail),
    scale: range(v.scale, 50, 200, 5, fallback.scale),
    pixelRatio: member(v.pixelRatio, [1, 1.5, 2, 3], fallback.pixelRatio),
    antialias: member(
      v.antialias,
      ["off", "fxaa", "smaa"] as const,
      fallback.antialias,
    ),
    shadows: member(v.shadows, [0, 1024, 2048, 4096], fallback.shadows),
    aoSamples: member(v.aoSamples, [0, 16, 32, 64], fallback.aoSamples),
    aoResolution: member(v.aoResolution, [0.5, 0.75, 1], fallback.aoResolution),
    depthOfField: range(v.depthOfField, 0, 150, 5, fallback.depthOfField),
    transmission: member(
      v.transmission,
      [0.25, 0.5, 0.75, 1],
      fallback.transmission,
    ),
    anisotropy: member(v.anisotropy, [1, 2, 4, 8, 16], fallback.anisotropy),
  };
}

/** Only repair the exact stock settings shipped by 0.2.10–0.2.12. A saved
 * revision makes subsequent deliberate choices (including 1×/auto/FXAA) stick.
 * Custom settings, full-model choices and the independent FPS cap survive. */
export function restoreOriginalQuality(
  value: unknown,
  preset: unknown,
  revision: unknown,
): RenderQuality {
  const quality = normalizeQuality(value);
  if (revision === 1 || preset !== "original" || !value || typeof value !== "object")
    return quality;
  const stored = value as Record<string, unknown>;
  const degradedStock = {
    scale: 100, pixelRatio: 1, shadows: 2048, aoSamples: 32,
    aoResolution: 1, depthOfField: 100, transmission: 1, anisotropy: 16,
  };
  if ((stored.modelDetail === undefined || stored.modelDetail === "auto") &&
      (stored.antialias === "off" || stored.antialias === "fxaa") &&
      Object.entries(degradedStock).every(([key, expected]) => stored[key] === expected))
    return { ...qualityPresets.original, frameRate: quality.frameRate };
  return quality;
}

export function matchingPreset(
  quality: RenderQuality,
): QualityPreset | "custom" {
  return (
    (Object.keys(qualityPresets) as QualityPreset[]).find((key) =>
      Object.entries(qualityPresets[key]).every(
        ([field, value]) => field === "frameRate" || quality[field as keyof RenderQuality] === value,
      ),
    ) ?? "custom"
  );
}

export function renderDimensions(
  quality: RenderQuality,
  width: number,
  height: number,
  stageScale: number,
  deviceRatio: number,
  maxTextureSize: number,
) {
  const requested =
    (Math.min(deviceRatio, quality.pixelRatio) * stageScale * quality.scale) /
    100;
  // Bound all full-resolution postprocessing targets to 8.3 MP and device limits.
  const ratio = Math.min(
    requested,
    Math.sqrt(8_294_400 / Math.max(1, width * height)),
    maxTextureSize / Math.max(1, width, height),
  );
  return {
    ratio,
    width: Math.max(1, Math.floor(width * ratio)),
    height: Math.max(1, Math.floor(height * ratio)),
    limited: ratio < requested - 0.0001,
  };
}
