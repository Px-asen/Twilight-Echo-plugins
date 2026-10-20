import type { MusicPlayerState } from "../music-browser-player";
import { SurfaceTransition } from "../ui-transitions";
import { setupTransportTitle } from "../music-transport-title";
import { getMusicMotionSpeed } from "../music-motion-settings";
import {
  buildLyricLines,
  getLyricWordProgress,
  type LyricLine,
  type LyricWord,
} from "./vendor/lyrics.ts";
import {
  buildLyricTimeline,
  type LyricTimelineEntry,
} from "./vendor/lyricTimeline.ts";
import { resolveLyricWordTimings } from "./vendor/lyricWordChunks.ts";
import {
  LyricClock,
  LyricHeights,
  LyricRequests,
  type LyricPayload,
} from "./runtime.ts";

const timeLabel = (time: number) =>
  `${Math.floor(Math.max(0, time) / 60)}:${String(Math.floor(Math.max(0, time) % 60)).padStart(2, "0")}`;
const glyph = (path: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">${path}</svg>`;
const play = glyph(
  '<path d="m9 5 11 7-11 7Z" fill="currentColor" stroke="none"/>',
);
const pause = glyph('<path d="M8 5v14M16 5v14" stroke-width="3"/>');
export const lyricsMarkup = `<section id="music-lyrics" class="music-lyrics" aria-label="音频档案 · 歌词" hidden inert>
  <button class="music-back lyrics-close" type="button" data-action="close-lyrics">← 返回原位置 <kbd>ESC</kbd></button>
  <div class="lyrics-disc-caption"><span>AUDIO ARCHIVE / LIVE</span><small>拖动 CD，查看完整封面</small></div>
  <article class="lyrics-reader">
    <header class="lyrics-heading"><div class="lyrics-overline"><span>RHINE LAB / AUDIO RECORD</span><span class="lyrics-format">LYRICS</span></div>
      <button class="lyrics-title" type="button" aria-label="定位当前歌曲"><span class="lyrics-title-label"></span></button>
      <p class="lyrics-artist"></p></header>
    <div class="lyrics-body"><div class="lyrics-position" aria-hidden="true"><i></i></div>
      <div class="lyrics-content" hidden><div class="lyrics-viewport" tabindex="0" role="region" aria-label="歌词，可滚动；点击定时歌词跳转"><div class="lyrics-spacer"><div class="lyrics-window"></div></div></div></div>
      <div class="lyrics-state" role="status"><small>LYRIC ARCHIVE</small><h2>正在读取歌词</h2><p></p><button type="button" class="lyrics-retry">重新读取 ↻</button></div>
      <button type="button" class="lyrics-follow" hidden>回到当前 ↗</button>
    </div>
    <footer class="lyrics-controls"><div class="lyrics-seek"><span class="lyrics-time">0:00</span><input type="range" min="0" max="1" step="0.01" value="0" aria-label="播放进度"><span class="lyrics-duration">0:00</span></div>
      <div class="lyrics-control-row"><span class="lyrics-sync-status">等待音频</span><div class="lyrics-playback">
        <button type="button" class="lyrics-previous" aria-label="上一首">${glyph('<path d="M5 5v14m14-14L8 12l11 7Z"/>')}</button>
        <button type="button" class="lyrics-toggle" aria-label="播放">${play}</button>
        <button type="button" class="lyrics-next" aria-label="下一首">${glyph('<path d="M19 5v14M5 5l11 7L5 19Z"/>')}</button></div>
        <button type="button" class="lyrics-translation" aria-pressed="true" hidden>译文 <span>ON</span></button>
      </div></footer>
  </article></section>`;

interface Ports {
  read(): Promise<LyricPayload>;
  seek(time: number): void;
  previous(): unknown;
  toggle(): unknown;
  next(): unknown;
  locate(): void;
  reduced(): boolean;
}
interface RenderRow {
  node: HTMLElement;
  words: { node: HTMLElement; word: LyricWord; progress: number }[];
  hot: boolean;
  distance: number;
  wordTime?: number;
  wordCursor: number;
  singing: Set<number>;
}

/** DOM reading surface; its only ticking owner is music-app's existing frame. */
export class LyricsReader {
  private readonly root: HTMLElement;
  private readonly viewport: HTMLElement;
  private readonly spacer: HTMLElement;
  private readonly window: HTMLElement;
  private readonly content: HTMLElement;
  private readonly stateNode: HTMLElement;
  private readonly follow: HTMLButtonElement;
  private readonly range: HTMLInputElement;
  private readonly translation: HTMLButtonElement;
  private readonly sync: HTMLElement;
  private readonly surface: SurfaceTransition;
  private readonly contentTransition: SurfaceTransition;
  private readonly title: ReturnType<typeof setupTransportTitle>;
  private readonly requests: LyricRequests;
  private readonly clock = new LyricClock();
  private readonly heights = new LyricHeights();
  private rows = new Map<number, RenderRow>();
  private lines: LyricLine[] = [];
  private parsedLines: LyricLine[] = [];
  private timeline: LyricTimelineEntry[] = [];
  private times: { time: number; index: number }[] = [];
  private state?: MusicPlayerState;
  private active = false;
  private shown = false;
  private disposed = false;
  private trackId = "";
  private signature = "";
  private layoutDirty = true;
  private measureDirty = false;
  private width = 0;
  private height = 0;
  private padding = 0;
  private bottomPadding = 0;
  private scroll = 0;
  private first = -1;
  private last = -1;
  private anchor = -1;
  private manualUntil = 0;
  private pointer = false;
  private scrubbing = false;
  private translated = true;
  private scrollMotion?: { from: number; to: number; elapsed: number };
  private lastFrame = 0;
  private displayedSecond = -1;
  private contentRevision = 0;
  private readonly observer: ResizeObserver;
  private readonly abort = new AbortController();
  private parsedCount = 0;
  private measuredCount = 0;
  constructor(
    stage: HTMLElement,
    private ports: Ports,
  ) {
    this.root = stage.querySelector("#music-lyrics")!;
    const q = <T extends HTMLElement = HTMLElement>(s: string) =>
      this.root.querySelector<T>(s)!;
    this.viewport = q(".lyrics-viewport");
    this.spacer = q(".lyrics-spacer");
    this.window = q(".lyrics-window");
    this.content = q(".lyrics-content");
    this.stateNode = q(".lyrics-state");
    this.follow = q(".lyrics-follow");
    this.range = q(".lyrics-seek input");
    this.translation = q(".lyrics-translation");
    this.sync = q(".lyrics-sync-status");
    this.surface = new SurfaceTransition(
      this.root,
      q(".lyrics-reader"),
      360,
      240,
      "right",
      undefined,
      [
        q(".lyrics-heading"),
        q(".lyrics-body"),
        q(".lyrics-controls"),
        q(".lyrics-close"),
        q(".lyrics-disc-caption"),
      ],
    );
    this.contentTransition = new SurfaceTransition(
      this.content,
      this.window,
      360,
      160,
      "up",
    );
    this.title = setupTransportTitle(
      q(".lyrics-title"),
      q(".lyrics-title-label"),
    );
    this.requests = new LyricRequests(ports.read);
    const on = (
      node: HTMLElement,
      event: string,
      handler: EventListener,
      options: AddEventListenerOptions = {},
    ) =>
      node.addEventListener(event, handler, {
        ...options,
        signal: this.abort.signal,
      });
    on(q(".lyrics-title"), "click", () => ports.locate());
    on(q(".lyrics-previous"), "click", () => void ports.previous());
    on(q(".lyrics-toggle"), "click", () => void ports.toggle());
    on(q(".lyrics-next"), "click", () => void ports.next());
    on(q(".lyrics-retry"), "click", () => void this.reload());
    on(this.follow, "click", () => this.resumeFollow());
    on(this.translation, "click", () => {
      this.translated = !this.translated;
      this.translation.setAttribute("aria-pressed", String(this.translated));
      this.translation.querySelector("span")!.textContent = this.translated
        ? "ON"
        : "OFF";
      this.root.dataset.translation = String(this.translated);
      this.resetLayout();
    });
    on(
      this.viewport,
      "wheel",
      (e) => {
        e.stopPropagation();
        this.manual();
      },
      { passive: true },
    );
    on(
      this.viewport,
      "pointerdown",
      () => {
        this.pointer = true;
        this.manual();
      },
      { passive: true },
    );
    window.addEventListener(
      "pointerup",
      () => {
        if (this.pointer) {
          this.pointer = false;
          this.manual();
        }
      },
      { signal: this.abort.signal },
    );
    window.addEventListener(
      "pointercancel",
      () => {
        this.pointer = false;
      },
      { signal: this.abort.signal },
    );
    on(this.viewport, "keydown", (event) => {
      const e = event as KeyboardEvent;
      if (
        [
          "ArrowUp",
          "ArrowDown",
          "PageUp",
          "PageDown",
          "Home",
          "End",
          " ",
        ].includes(e.key)
      )
        this.manual();
    });
    on(
      this.viewport,
      "scroll",
      () => {
        this.scroll = this.viewport.scrollTop;
        if (this.manualUntil) this.manual();
      },
      { passive: true },
    );
    on(this.window, "click", (event) => {
      const target = (event.target as Element).closest<HTMLElement>(
        "[data-lyric-index]",
      );
      if (!target) return;
      const line = this.lines[Number(target.dataset.lyricIndex)];
      if (line?.time != null) {
        this.seek(line.time);
        this.resumeFollow();
      }
    });
    on(this.range, "pointerdown", () => {
      this.scrubbing = true;
    });
    on(this.range, "input", () => {
      this.scrubbing = true;
      q(".lyrics-time").textContent = timeLabel(Number(this.range.value));
    });
    on(this.range, "change", () => {
      this.seek(Number(this.range.value));
      this.scrubbing = false;
      this.resumeFollow();
    });
    on(this.range, "pointercancel", () => {
      this.scrubbing = false;
    });
    this.observer = new ResizeObserver(() => {
      this.layoutDirty = true;
    });
    this.observer.observe(this.viewport);
    document.fonts.addEventListener("loadingdone", this.fontChanged);
    void document.fonts.ready.then(() => {
      if (!this.disposed) this.resetLayout();
    });
  }
  private fontChanged = () => this.resetLayout();
  get isActive() {
    return this.active;
  }
  get stats() {
    return {
      active: this.active,
      shown: this.shown,
      lines: this.lines.length,
      rendered: this.rows.size,
      parses: this.parsedCount,
      measuredRows: this.measuredCount,
      trackId: this.trackId,
      anchor: this.anchor,
      following: !this.manualUntil,
    };
  }
  setActive(active: boolean, state?: MusicPlayerState) {
    this.active = active;
    this.lastFrame = 0;
    if (active) {
      const changed = (state?.currentTrack?.id ?? "") !== this.trackId;
      if (state) this.accept(state);
      this.resetLayout();
      if (!changed) void this.reload();
    } else {
      this.requests.cancel();
      this.contentRevision++;
      this.scrollMotion = undefined;
    }
  }
  show() {
    this.shown = true;
    this.surface.show(this.ports.reduced());
    this.root.inert = false;
    this.root.setAttribute("aria-hidden", "false");
    this.layoutDirty = true;
    this.title.setReduced(this.ports.reduced());
    this.title.update(this.state?.currentTrack?.title ?? "尚未播放", true);
    this.viewport.focus({ preventScroll: true });
  }
  hide(done: () => void = () => {}, immediate = false) {
    this.shown = false;
    this.lastFrame = 0;
    this.root.inert = true;
    this.root.setAttribute("aria-hidden", "true");
    this.surface.hide(immediate || this.ports.reduced(), done);
  }
  setReduced() {
    this.title.setReduced(this.ports.reduced());
    if (this.ports.reduced()) {
      this.surface.finish();
      this.contentTransition.finish();
      if (this.scrollMotion) {
        this.scroll = this.scrollMotion.to;
        this.viewport.scrollTop = this.scroll;
        this.scrollMotion = undefined;
      }
    }
  }
  setInert(inert: boolean) {
    this.root.inert = inert || !this.shown;
  }
  suspend() {
    this.lastFrame = 0;
  }
  resume() {
    this.lastFrame = 0;
    if (this.state) this.clock.sample(this.state, performance.now());
    if (this.active) this.layoutDirty = true;
  }
  accept(state: MusicPlayerState) {
    this.clock.sample(state, performance.now());
    const id = state.currentTrack?.id ?? "";
    const changed = id !== this.trackId;
    this.state = state;
    if (!this.active) return;
    this.title.update(state.currentTrack?.title ?? "尚未播放", this.shown);
    this.root.querySelector(".lyrics-artist")!.textContent =
      state.currentTrack?.artist || "等待播放歌曲";
    const toggle =
      this.root.querySelector<HTMLButtonElement>(".lyrics-toggle")!;
    if (toggle.dataset.playing !== String(state.playing)) {
      toggle.dataset.playing = String(state.playing);
      toggle.innerHTML = state.playing ? pause : play;
    }
    toggle.setAttribute("aria-label", state.playing ? "暂停" : "播放");
    toggle.setAttribute("aria-pressed", String(state.playing));
    this.range.max = String(Math.max(1, state.duration));
    this.root.querySelector(".lyrics-duration")!.textContent = timeLabel(
      state.duration,
    );
    for (const button of this.root.querySelectorAll<HTMLButtonElement>(
      ".lyrics-playback button",
    ))
      button.disabled = !id;
    this.range.disabled = !id || !state.duration;
    if (changed) {
      this.trackId = id;
      this.signature = "";
      this.parsedLines = [];
      this.anchor = -1;
      this.displayedSecond = -1;
      this.manualUntil = 0;
      this.follow.hidden = true;
      this.scrollMotion = undefined;
      void this.reload();
    }
  }
  async reload() {
    if (!this.active || this.disposed) return;
    const id = this.state?.currentTrack?.id;
    const revision = ++this.contentRevision;
    if (!id) {
      this.requests.cancel();
      this.replace(
        [],
        "idle",
        "尚未播放歌曲",
        "播放一首歌曲，即可打开对应的音频档案。",
      );
      return;
    }
    // Retire the old document once, never decrypt each incoming lyric line.
    const retired = new Promise<void>((resolve) => {
      this.contentTransition.hide(this.ports.reduced(), () => {
        if (revision === this.contentRevision)
          this.showState("loading", "正在读取歌词", "");
        resolve();
      });
    });
    const result = await this.requests.load(id);
    if (!result || revision !== this.contentRevision || !this.active) return;
    await retired;
    if (revision !== this.contentRevision || !this.active || this.disposed) return;
    if (result.status === "ready") {
      const signature = JSON.stringify([
        id,
        result.payload.lyrics,
        result.payload.translatedLyrics,
      ]);
      if (signature !== this.signature) {
        try {
          this.parsedLines = buildLyricLines(
            result.payload.lyrics,
            result.payload.translatedLyrics?.trim()
              ? result.payload.translatedLyrics
              : undefined,
          );
          this.parsedCount++;
          this.signature = signature;
        } catch (error) {
          this.replace([], "error", "歌词解析失败", String(error));
          return;
        }
      }
      if (!this.parsedLines.length)
        this.replace([], "empty", "当前歌曲暂无歌词", "可以稍后重新读取。");
      else this.replace(this.parsedLines, "ready");
    } else
      this.replace(
        [],
        result.status,
        result.status === "empty" ? "当前歌曲暂无歌词" : "歌词读取失败",
        result.message,
      );
  }
  private showState(status: string, title: string, message: string) {
    this.root.dataset.lyricState = status;
    this.stateNode.hidden = false;
    this.stateNode.querySelector("h2")!.textContent = title;
    this.stateNode.querySelector("p")!.textContent = message;
    this.stateNode.querySelector<HTMLButtonElement>("button")!.hidden =
      status === "loading" || status === "idle";
    this.translation.hidden = true;
    this.sync.textContent = status === "loading" ? "正在读取" : "LYRIC ARCHIVE";
  }
  private replace(
    lines: LyricLine[],
    status: string,
    title = "",
    message = "",
  ) {
    this.lines = lines;
    this.timeline = buildLyricTimeline(lines);
    this.times = this.timeline
      .flatMap((e) =>
        e.timed && e.time != null ? [{ time: e.time, index: e.index }] : [],
      )
      .sort((a, b) => a.time - b.time);
    this.anchor = -1;
    this.first = this.last = -1;
    this.rows.clear();
    this.window.replaceChildren();
    this.root.dataset.lyricState = status;
    this.scroll = 0;
    this.viewport.scrollTop = 0;
    this.resetLayout();
    if (status !== "ready") {
      this.contentTransition.hide(true);
      this.showState(status, title, message);
      return;
    }
    this.stateNode.hidden = true;
    this.translation.hidden = !lines.some(
      (line) =>
        line.translation ||
        line.voices?.some((voice) => voice.translation?.text),
    );
    this.root.dataset.timed = String(!!this.times.length);
    this.root.querySelector(".lyrics-format")!.textContent = lines.some(
      (line) => line.words?.length || line.voices?.some((v) => v.words?.length),
    )
      ? "WORD SYNC"
      : this.times.length
        ? "LINE SYNC"
        : "TEXT ARCHIVE";
    this.contentTransition.show(this.ports.reduced());
    this.layoutDirty = true;
  }
  private resetLayout() {
    this.width = 0;
    this.layoutDirty = true;
  }
  private manual() {
    if (!this.times.length) return;
    this.manualUntil = performance.now() + 5000;
    this.scrollMotion = undefined;
    this.follow.hidden = false;
  }
  private resumeFollow() {
    this.manualUntil = 0;
    this.follow.hidden = true;
    this.moveToAnchor();
  }
  private seek(time: number) {
    this.clock.seek(time, performance.now());
    this.ports.seek(time);
    this.anchor = -1;
  }
  private targetScroll() {
    if (this.anchor < 0) return 0;
    return Math.max(0, this.heights.offsets[this.anchor] ?? 0);
  }
  private moveToAnchor() {
    if (this.manualUntil || this.anchor < 0) return;
    const to = this.targetScroll();
    if (this.ports.reduced()) {
      this.scroll = to;
      this.viewport.scrollTop = to;
      this.scrollMotion = undefined;
    } else this.scrollMotion = { from: this.scroll, to, elapsed: 0 };
  }
  private renderWindow() {
    const { first, last } = this.heights.window(
      this.scroll,
      this.height,
      this.padding,
    );
    if (first === this.first && last === this.last) return;
    this.first = first;
    this.last = last;
    for (const [index, row] of this.rows)
      if (index < first || index >= last) {
        row.node.remove();
        this.rows.delete(index);
      }
    for (let index = first; index < last; index++) {
      if (this.rows.has(index)) continue;
      const line = this.lines[index];
      const node = document.createElement(line.time == null ? "div" : "button");
      if (node instanceof HTMLButtonElement) node.type = "button";
      node.className = "lyric-row";
      node.dataset.lyricIndex = String(index);
      node.setAttribute("aria-setsize", String(this.lines.length));
      node.setAttribute("aria-posinset", String(index + 1));
      const meta = document.createElement("span");
      meta.className = "lyric-meta";
      meta.textContent = `${String(index + 1).padStart(3, "0")}  /  ${line.time == null ? "TEXT" : timeLabel(line.time)}`;
      const body = document.createElement("span");
      body.className = "lyric-text";
      const words: RenderRow["words"] = [];
      const addText = (
        parent: HTMLElement,
        text: string,
        source?: LyricWord[],
      ) => {
        if (!source?.length) {
          parent.textContent = text || "···";
          return;
        }
        for (const word of resolveLyricWordTimings(
          source,
          this.timeline[index]?.endTime,
        )) {
          if (!word.text.trim()) {
            parent.append(document.createTextNode(word.text));
            continue;
          }
          const span = document.createElement("span");
          span.className = "lyric-word";
          span.textContent = word.text;
          parent.append(span);
          words.push({ node: span, word, progress: -1 });
        }
      };
      if (line.voices?.length) {
        for (const voice of line.voices) {
          const p = document.createElement("span");
          p.className = `lyric-voice lyric-voice-${voice.role}`;
          addText(p, voice.text, voice.words);
          body.append(p);
          if (voice.translation?.text) {
            const t = document.createElement("span");
            t.className = "lyric-translation";
            t.textContent = voice.translation.text;
            body.append(t);
          }
        }
      } else addText(body, line.text, line.words);
      if (line.translation && !line.voices?.some((v) => v.translation?.text)) {
        const t = document.createElement("span");
        t.className = "lyric-translation";
        t.textContent = line.translation;
        body.append(t);
      }
      node.append(meta, body);
      if (words.length) node.classList.add("has-words");
      if (line.time != null)
        node.setAttribute(
          "aria-label",
          `${timeLabel(line.time)} ${line.text || "间奏"}`,
        );
      const before = [...this.rows.entries()].find(([key]) => key > index)?.[1]
        .node;
      this.window.insertBefore(node, before ?? null);
      words.sort((a, b) => a.word.time - b.word.time);
      this.rows.set(index, {
        node,
        words,
        hot: false,
        distance: -1,
        wordCursor: 0,
        singing: new Set(),
      });
    }
    this.measureDirty = true;
    this.positionWindow();
  }
  private updateWords(row: RenderRow, position: number) {
    if (!row.words.length || row.wordTime === position) return;
    const paint = (index: number) => {
      const item = row.words[index];
      const progress =
        Math.round(getLyricWordProgress(item.word, null, position) * 1000) / 10;
      if (progress !== item.progress) {
        item.progress = progress;
        item.node.style.setProperty("--word-fill", `${progress}%`);
      }
      return progress;
    };
    if (
      row.wordTime === undefined ||
      position < row.wordTime ||
      position - row.wordTime > 1
    ) {
      // Mounts/seeks reconcile the visible document once, including overlapping voices.
      row.singing.clear();
      row.wordCursor = 0;
      for (let i = 0; i < row.words.length; i++) {
        const progress = paint(i);
        if (row.words[i].word.time <= position) {
          row.wordCursor = i + 1;
          if (progress < 100) row.singing.add(i);
        }
      }
    } else {
      // Normal playback visits only words crossing a timestamp or still filling.
      while (
        row.wordCursor < row.words.length &&
        row.words[row.wordCursor].word.time <= position
      )
        row.singing.add(row.wordCursor++);
      for (const index of row.singing)
        if (paint(index) === 100) row.singing.delete(index);
    }
    row.wordTime = position;
  }

  private positionWindow() {
    this.spacer.style.height = `${this.padding + this.heights.offsets.at(-1)! + this.bottomPadding}px`;
    this.window.style.top = `${this.padding + (this.heights.offsets[this.first] || 0)}px`;
  }
  update(now: number) {
    if (!this.active || !this.shown || this.disposed || document.hidden) return;
    const dt = this.lastFrame
      ? Math.min(80, Math.max(0, now - this.lastFrame))
      : 0;
    this.lastFrame = now;
    if (this.layoutDirty && !this.content.hidden) {
      this.layoutDirty = false;
      const width = this.viewport.clientWidth,
        height = this.viewport.clientHeight;
      this.height = height;
      this.padding = height * 0.38;
      this.bottomPadding = height * 0.62;
      if (width !== this.width) {
        this.width = width;
        // Initial estimates only. Mounted rows are measured once at this width.
        this.heights.reset(this.lines.length, width < 550 ? 108 : 124);
        this.first = this.last = -1;
        this.rows.clear();
        this.window.replaceChildren();
      }
      this.positionWindow();
      this.moveToAnchor();
      this.measureDirty = true;
    }
    const position = this.clock.at(now);
    let lo = 0,
      hi = this.times.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.times[mid].time <= position) lo = mid + 1;
      else hi = mid;
    }
    const anchor = this.times.length
      ? this.times[Math.max(0, lo - 1)].index
      : -1;
    if (anchor !== this.anchor) {
      this.anchor = anchor;
      this.moveToAnchor();
    }
    if (this.manualUntil && !this.pointer && now >= this.manualUntil)
      this.resumeFollow();
    if (this.scrollMotion && !this.pointer) {
      const m = this.scrollMotion;
      m.elapsed += dt * getMusicMotionSpeed();
      const t = Math.min(1, m.elapsed / 460),
        eased = t * t * (3 - 2 * t);
      this.scroll = m.from + (m.to - m.from) * eased;
      this.viewport.scrollTop = this.scroll;
      if (t === 1) this.scrollMotion = undefined;
    }
    if (this.lines.length && !this.content.hidden) this.renderWindow();
    // Layout reads are confined to newly mounted/changed rows, never the steady frame path.
    if (this.measureDirty && !this.content.hidden) {
      this.measureDirty = false;
      let changed = false;
      const before =
        this.heights.offsets[this.heights.indexAt(this.scroll)] || 0;
      const at = this.heights.indexAt(this.scroll);
      for (const [index, row] of this.rows) {
        const height = row.node.getBoundingClientRect().height;
        this.measuredCount++;
        if (
          height > 0 &&
          Math.abs(this.heights.heights[index] - height) > 0.5
        ) {
          this.heights.heights[index] = height;
          changed = true;
        }
      }
      if (changed) {
        this.heights.rebuild();
        const delta = this.heights.offsets[at] - before;
        this.scroll += delta;
        this.viewport.scrollTop = this.scroll;
        if (this.scrollMotion) {
          this.scrollMotion.from += delta;
          this.scrollMotion.to = this.targetScroll();
        }
        this.positionWindow();
      }
    }
    for (const [index, row] of this.rows) {
      const entry = this.timeline[index];
      const hot =
        !!entry?.timed &&
        entry.time! <= position &&
        entry.endTime! > position &&
        !!this.lines[index].text;
      if (hot !== row.hot) {
        row.hot = hot;
        row.node.classList.toggle("current", hot);
        if (hot) row.node.setAttribute("aria-current", "true");
        else row.node.removeAttribute("aria-current");
      }
      const distance =
        this.anchor < 0 ? 0 : Math.min(3, Math.abs(index - this.anchor));
      if (distance !== row.distance) {
        row.distance = distance;
        row.node.dataset.distance = String(distance);
      }
      this.updateWords(row, position);
    }
    const second = Math.floor(position);
    if (second !== this.displayedSecond) {
      this.displayedSecond = second;
      if (!this.scrubbing)
        this.root.querySelector(".lyrics-time")!.textContent =
          timeLabel(position);
    }
    if (!this.scrubbing) this.range.value = String(position);
    if (this.lines.length) {
      const entry = this.timeline[this.anchor];
      const interlude =
        entry &&
        (this.lines[this.anchor].text.trim() === "" ||
          (entry.endTime! < position &&
            (this.times[lo]?.time ?? Infinity) - position > 4));
      const label = !this.times.length
        ? "纯文本 / 自由阅读"
        : this.state?.loading || this.state?.buffering
          ? "正在缓冲"
          : interlude || lo === 0
            ? "间奏 / INSTRUMENTAL"
            : this.state?.playing
              ? "同步播放 / LIVE"
              : "已暂停 / PAUSED";
      if (this.sync.textContent !== label) this.sync.textContent = label;
    }
  }
  dispose() {
    this.disposed = true;
    this.active = this.shown = false;
    this.window.replaceChildren();
    this.requests.cancel();
    this.abort.abort();
    this.observer.disconnect();
    document.fonts.removeEventListener("loadingdone", this.fontChanged);
    this.surface.dispose();
    this.contentTransition.dispose();
    this.title.destroy();
    this.rows.clear();
    this.lines = [];
    this.parsedLines = [];
    this.timeline = [];
    this.times = [];
  }
}
