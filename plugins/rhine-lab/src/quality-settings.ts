import {
  matchingPreset,
  presetLabels,
  qualityDescription,
  type QualityPreset,
  type RenderQuality,
} from "./render-quality";
import { frameRates } from "./frame-limiter";

function select(
  quality: RenderQuality,
  key: keyof RenderQuality,
  label: string,
  hint: string,
  choices: (readonly [string | number, string])[],
) {
  return `<label class="quality-control"><span>${label}<small>${hint}</small></span><select data-quality="${key}" aria-label="${label}">${choices.map(([value, text]) => `<option value="${value}" ${quality[key] === value ? "selected" : ""}>${text}</option>`).join("")}</select></label>`;
}
function range(
  quality: RenderQuality,
  key: "scale" | "depthOfField",
  label: string,
  hint: string,
  min: number,
  max: number,
) {
  return `<label class="quality-control quality-range"><span>${label}<small>${hint}</small></span><div><input type="range" data-quality="${key}" aria-label="${label}" min="${min}" max="${max}" step="5" value="${quality[key]}"/><output data-quality-output="${key}">${quality[key]}%</output></div></label>`;
}
export function qualityMarkup(quality: RenderQuality, music = false) {
  const preset = matchingPreset(quality);
  return `<section class="quality-settings" aria-label="画质设置">
    <div class="quality-heading"><h3>${music ? "画质" : "RENDER QUALITY <span>渲染画质</span>"}</h3><select id="quality-preset" aria-label="画质预设">${(Object.keys(presetLabels) as QualityPreset[]).map((key) => `<option value="${key}" ${preset === key ? "selected" : ""}>${presetLabels[key]}</option>`).join("")}<option value="custom" disabled ${preset === "custom" ? "selected" : ""}>自定义</option></select></div>
    <p class="quality-summary" id="quality-summary" aria-live="polite"></p>
    <p class="quality-note" id="quality-profile-note" aria-live="polite" data-quality-profile="${preset}">${qualityDescription(quality)}</p>
    ${select(quality, "frameRate", "帧率上限", "默认 60 FPS；降低帧率可减少显卡占用与功耗", frameRates.map((v) => [v, `${v} FPS`]))}
    <details class="quality-advanced"><summary>精细设置 <span>清晰度 / 材质 / 阴影</span></summary><div class="quality-grid">
    ${music ? select(quality, "modelDetail", "模型细节", "原始画质使用完整模型；自动分级会减少远处倒角细节", [["auto", "自动分级"], ["full", "完整模型"]]) : ""}
    ${range(quality, "scale", "渲染比例", "相对屏幕像素，受密度上限限制；高比例改善细线", 50, 200)}
    ${select(
      quality,
      "pixelRatio",
      "像素密度上限",
      "控制高密度屏幕的原生像素倍率",
      [1, 1.5, 2, 3].map((v) => [v, `${v}×`]),
    )}
    ${select(quality, "antialias", "抗锯齿", "SMAA 保留更多细节；轻量 FXAA 会柔化细线和纹理", [
      ["off", "关闭"],
      ["fxaa", "轻量 FXAA"],
      ["smaa", "SMAA"],
    ])}
    ${select(
      quality,
      "anisotropy",
      "纹理过滤",
      "改善倾斜视角下的标签细节",
      [1, 2, 4, 8, 16].map((v) => [v, `${v}×`]),
    )}
    ${select(
      quality,
      "transmission",
      "透明材质分辨率",
      "控制盖板折射画面的清晰度",
      [0.25, 0.5, 0.75, 1].map((v) => [v, `${v * 100}%`]),
    )}
    ${select(
      quality,
      "shadows",
      "阴影分辨率 · 阵列",
      "更高分辨率保留更细的投影边缘",
      [
        [0, "关闭"],
        [1024, "1024"],
        [2048, "2048"],
        [4096, "4096"],
      ],
    )}
    ${select(
      quality,
      "aoSamples",
      "环境遮蔽 · 阵列",
      "采样越多，接缝暗部越细腻",
      [
        [0, "关闭"],
        [16, "16 采样"],
        [32, "32 采样"],
        [64, "64 采样"],
      ],
    )}
    ${select(
      quality,
      "aoResolution",
      "遮蔽分辨率 · 阵列",
      "降低可减轻环境遮蔽的渲染负担",
      [0.5, 0.75, 1].map((v) => [v, `${v * 100}%`]),
    )}
    ${range(quality, "depthOfField", "景深强度 · 阵列", "0% 关闭；100% 保留原始镜头虚化", 0, 150)}
    </div>${music ? '<p class="quality-note">清晰度与材质设置同步至 360° 查看器。渲染比例越高，性能开销越大。缓冲上限为 829 万像素，超过硬件限制时会自动降低。</p>' : ""}</details><p class="quality-note">${music ? "调整立即生效并自动保存。" : "即时生效并自动保存。清晰度与材质设置同步至 360° 查看器。高渲染比例更适合静态观察；缓冲上限为 829 万像素，硬件限制时自动收敛。"}</p>
  </section>`;
}

export function syncQualityUI(quality: RenderQuality) {
  const preset = document.querySelector<HTMLSelectElement>("#quality-preset");
  if (!preset) return;
  preset.value = matchingPreset(quality);
  const note = document.querySelector<HTMLElement>("#quality-profile-note");
  if (note) {
    note.textContent = qualityDescription(quality);
    note.dataset.qualityProfile = matchingPreset(quality);
  }
  document
    .querySelectorAll<HTMLInputElement | HTMLSelectElement>("[data-quality]")
    .forEach((control) => {
      const key = control.dataset.quality as keyof RenderQuality;
      control.value = String(quality[key]);
      control.disabled = key === "aoResolution" && quality.aoSamples === 0;
    });
  document
    .querySelectorAll<HTMLOutputElement>("[data-quality-output]")
    .forEach((output) => {
      output.value = `${quality[output.dataset.qualityOutput as keyof RenderQuality]}%`;
    });
}
