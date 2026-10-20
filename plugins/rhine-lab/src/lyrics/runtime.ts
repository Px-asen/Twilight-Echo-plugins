/** Playback time is deliberately independent from the interface motion scale. */
export interface ClockSample {
  currentTrack: { id: string } | null;
  currentTime: number;
  duration: number;
  playing: boolean;
  loading: boolean;
  playbackRate?: number;
  buffering?: boolean;
}
export class LyricClock {
  private id = "";
  private time = 0;
  private stamp = 0;
  private rate = 1;
  private running = false;
  private duration = 0;
  private lastSample = -1;
  private seekUntil = 0;
  sample(state: ClockSample, now: number) {
    const id = state.currentTrack?.id ?? "";
    const changed = id !== this.id;
    const rate =
      Number.isFinite(state.playbackRate) && state.playbackRate! > 0
        ? state.playbackRate!
        : 1;
    const running = !!id && state.playing && !state.loading && !state.buffering;
    const value = Math.max(
      0,
      Number.isFinite(state.currentTime) ? state.currentTime : 0,
    );
    this.duration = Math.max(0, state.duration || 0);
    if (
      !changed &&
      now < this.seekUntil &&
      Math.abs(value - this.at(now)) > 0.8
    )
      return;
    if (
      changed ||
      value !== this.lastSample ||
      running !== this.running ||
      rate !== this.rate
    ) {
      this.time = value;
      this.stamp = now;
    }
    this.id = id;
    this.lastSample = value;
    this.running = running;
    this.rate = rate;
    if (changed) this.seekUntil = 0;
  }
  at(now: number) {
    const time =
      this.time +
      (this.running ? (Math.max(0, now - this.stamp) * this.rate) / 1000 : 0);
    return Math.max(
      0,
      this.duration > 0 ? Math.min(this.duration, time) : time,
    );
  }
  seek(time: number, now: number) {
    this.time = Math.max(0, time);
    this.stamp = now;
    this.seekUntil = now + 700;
  }
}

/** Prefix sums make both playhead jumps and user scrolls logarithmic. */
export class LyricHeights {
  heights: number[] = [];
  offsets: number[] = [0];
  reset(count: number, estimate: number) {
    this.heights = new Array(count).fill(estimate);
    this.rebuild();
  }
  rebuild() {
    this.offsets = [0];
    for (const height of this.heights)
      this.offsets.push(this.offsets.at(-1)! + height);
  }
  indexAt(offset: number) {
    let lo = 0,
      hi = this.heights.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.offsets[mid + 1] <= offset) lo = mid + 1;
      else hi = mid;
    }
    return Math.max(0, Math.min(this.heights.length - 1, lo));
  }
  window(scroll: number, height: number, padding: number) {
    const first = Math.max(0, this.indexAt(scroll - padding) - 7);
    const last = Math.min(
      this.heights.length,
      this.indexAt(scroll + height - padding) + 9,
    );
    return { first, last: Math.min(first + 48, last) };
  }
}

export interface LyricPayload {
  id?: string;
  lyrics?: string;
  translatedLyrics?: string;
}
export type LyricResult =
  | { status: "ready"; payload: LyricPayload }
  | { status: "empty" | "error"; message: string };
/** Every response must match both the song identity and this request generation. */
export class LyricRequests {
  private revision = 0;
  private id = "";
  private read: () => Promise<LyricPayload>;
  constructor(read: () => Promise<LyricPayload>) {
    this.read = read;
  }
  cancel() {
    this.revision++;
    this.id = "";
  }
  async load(id: string): Promise<LyricResult | undefined> {
    this.id = id;
    const revision = ++this.revision;
    try {
      const payload = await this.read();
      if (revision !== this.revision || id !== this.id) return;
      // The bridge reads the actual current track. Never relabel another song's result.
      if (payload.id !== id)
        return {
          status: "error",
          message: "歌词尚未切换到当前歌曲，请重新读取。",
        };
      if (!payload.lyrics?.trim())
        return { status: "empty", message: "当前歌曲暂无歌词" };
      return { status: "ready", payload };
    } catch (error) {
      if (revision !== this.revision || id !== this.id) return;
      return {
        status: "error",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
