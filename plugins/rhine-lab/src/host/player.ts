import type { MusicTrack } from "../music-types";
import type {
  MusicPlayerState,
  AudioCapabilities,
} from "../music-browser-player";
import type { SongTransitionMode } from "../music-song-transition";
import { callHost, initialPlayer, onHost, reportHostError } from "./bridge";
import { assetUrl } from "../asset-url";

type Fade = { timer: ReturnType<typeof setTimeout>; finish: () => void };
const unit = (value: number) => Math.max(0, Math.min(1, value));

/** Only ambience is played locally. Song audio and the queue belong to the host. */
export class TwilightMusicPlayer {
  private listeners = new Set<(state: MusicPlayerState) => void>();
  private stops: (() => void)[] = [];
  private disposed = false;
  private value: MusicPlayerState;
  private bgm = new Audio(assetUrl("audio/atmosphere.ogg"));
  private unlocked = false;
  private bgmRevision = 0;
  private bgmTarget = 0;
  private bgmTask: Promise<void> = Promise.resolve();
  private fade?: Fade;
  constructor(
    options: {
      volume?: number;
      songTransitionMode?: SongTransitionMode;
      songFadeEnabled?: boolean;
      bgmVolume?: number;
      bgmEnabled?: boolean;
    } = {},
  ) {
    this.value = {
      transport: "idle",
      currentTrack: null,
      queue: [],
      currentIndex: -1,
      playing: false,
      loading: false,
      duration: 0,
      currentTime: 0,
      volume: 0.65,
      songTransitionMode: "gapless",
      songFadeEnabled: false,
      bgmVolume: options.bgmVolume ?? 0.18,
      bgmEnabled: options.bgmEnabled ?? true,
      bgmPlaying: false,
      error: null,
      bgmError: null,
      backend: "twilight",
      outputDeviceId: "default",
      outputDevices: [],
      decoderAvailable: true,
      nativeAvailable: true,
      outputError: null,
      transitionWarning: null,
    };
    this.bgm.loop = true;
    this.bgm.preload = "none";
    this.bgm.volume = 0;
    this.bgm.addEventListener("error", () => {
      this.value.bgmError = "氛围音乐加载失败";
      this.value.bgmPlaying = false;
      this.emit();
    });
    this.accept(initialPlayer);
    this.stops.push(
      onHost("player", (state) => this.accept(state)),
      onHost("queue", () => void this.refreshQueue().catch(reportHostError)),
    );
    void this.refreshQueue().catch(reportHostError);
    document.addEventListener("pointerdown", this.gesture, { capture: true });
    document.addEventListener("keydown", this.gesture, { capture: true });
  }
  get state(): MusicPlayerState {
    return { ...this.value, queue: [...this.value.queue] };
  }
  subscribe(listener: (state: MusicPlayerState) => void) {
    this.listeners.add(listener);
    listener(this.state);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private accept(state: any) {
    if (this.disposed || !state) return;
    const {
      bgmEnabled,
      bgmVolume,
      bgmPlaying,
      bgmError,
      outputDevices,
      queue,
    } = this.value;
    this.value = {
      ...this.value,
      ...state,
      backend: "twilight",
      bgmEnabled,
      bgmVolume,
      bgmPlaying,
      bgmError,
      outputDevices,
      queue,
      songFadeEnabled: state.songTransitionMode !== "gapless",
    };
    void this.reconcileAmbience();
    this.emit();
  }
  private async command(method: string, args: Record<string, unknown> = {}) {
    try {
      if (method === "player.play") {
        this.value.transport = "loading";
        this.value.loading = true;
        await this.reconcileAmbience();
      }
      const result = await callHost(method, args);
      if (result?.transport) this.accept(result);
    } catch (error) {
      if (!this.disposed) {
        this.value.error = String(error);
        this.emit();
        reportHostError(error);
      }
    }
  }
  private async refreshQueue() {
    const queue = await callHost<MusicTrack[]>("player.queue");
    if (!this.disposed) {
      this.value.queue = queue;
      this.emit();
    }
  }
  async refreshOutputs(): Promise<AudioCapabilities> {
    const audio = await callHost("audio.read");
    const devices = audio.devices.map((item: any) => ({
      id: item.id ?? item.value ?? item.name,
      name: item.name ?? item.label ?? item.id,
    }));
    this.value.outputDevices = devices;
    this.value.outputDeviceId = audio.device;
    this.emit();
    return { decoderAvailable: true, nativeAvailable: true, devices };
  }
  async setBackend(
    _backend: "browser" | "coreaudio" | "twilight",
    deviceId = "default",
  ) {
    await this.setOutputDevice(deviceId);
  }
  async setOutputDevice(device: string) {
    await callHost("audio.output", { device });
    await this.refreshOutputs();
  }
  setQueue(tracks: readonly MusicTrack[]) {
    void this.command("player.setQueue", {
      ids: tracks.map((track) => track.id),
    });
  }
  async play(id: string, tracks?: readonly MusicTrack[]) {
    await this.command("player.play", {
      id,
      ...(tracks ? { ids: tracks.map((track) => track.id) } : {}),
    });
  }
  async toggle() {
    await this.command("player.toggle");
  }
  async next() {
    await this.command("player.next");
  }
  async previous() {
    await this.command("player.previous");
  }
  seek(value: number) {
    void this.command("player.seek", { value });
  }
  stop() {
    void this.command("player.stop");
  }
  setVolume(value: number) {
    void this.command("player.volume", { value });
  }
  setSongTransitionMode(mode: SongTransitionMode) {
    void this.command("player.transition", { mode });
  }
  setSongFadeEnabled(enabled: boolean) {
    this.setSongTransitionMode(enabled ? "fade-in-out" : "gapless");
  }
  setBgmVolume(value: number) {
    this.value.bgmVolume = Math.min(1, Math.max(0, value));
    void this.reconcileAmbience();
    this.emit();
  }
  setBgmEnabled(value: boolean) {
    this.value.bgmEnabled = value;
    void this.reconcileAmbience();
    this.emit();
  }
  private gesture = () => {
    this.unlocked = true;
    void this.reconcileAmbience();
  };
  private reconcileAmbience(): Promise<void> {
    const idle =
      this.value.transport === "idle" || this.value.transport === "error";
    const target =
      !this.disposed && this.unlocked && this.value.bgmEnabled && idle
        ? this.value.bgmVolume
        : 0;
    if (target === this.bgmTarget) return this.bgmTask;
    this.bgmTarget = target;
    const request = ++this.bgmRevision;
    this.cancelFade();
    this.bgmTask = (async () => {
      if (target > 0) {
        try {
          await this.bgm.play();
          if (this.disposed || request !== this.bgmRevision) {
            if (this.disposed || this.bgmTarget <= 0) this.bgm.pause();
            return;
          }
          this.value.bgmError = null;
          this.value.bgmPlaying = true;
          this.emit();
        } catch {
          if (!this.disposed && request === this.bgmRevision) {
            this.bgmTarget = -1;
            this.value.bgmPlaying = false;
            this.value.bgmError =
              "氛围配乐暂未获准播放或无法读取，请再次点击界面重试。";
            this.emit();
          }
          return;
        }
      }
      if (this.disposed || request !== this.bgmRevision) return;
      await this.fadeBgm(target, target > 0 ? 650 : 220);
      if (this.disposed || request !== this.bgmRevision) return;
      if (target === 0) this.bgm.pause();
      this.value.bgmPlaying = target > 0 && !this.bgm.paused;
      this.emit();
    })();
    return this.bgmTask;
  }

  private fadeBgm(target: number, duration: number): Promise<void> {
    this.cancelFade();
    const start = this.bgm.volume;
    if (this.bgm.paused || Math.abs(start - target) < 0.001) {
      this.bgm.volume = target;
      return Promise.resolve();
    }
    const startedAt = performance.now();
    return new Promise((resolve) => {
      const fade: Fade = {
        timer: 0 as unknown as ReturnType<typeof setTimeout>,
        finish: resolve,
      };
      const step = () => {
        if (this.fade !== fade) return;
        const progress = Math.min(
          1,
          (performance.now() - startedAt) / duration,
        );
        this.bgm.volume = unit(start + (target - start) * progress);
        if (progress < 1) fade.timer = setTimeout(step, 24);
        else {
          this.fade = undefined;
          resolve();
        }
      };
      this.fade = fade;
      step();
    });
  }

  private cancelFade(): void {
    if (!this.fade) return;
    const fade = this.fade;
    this.fade = undefined;
    clearTimeout(fade.timer);
    fade.finish();
  }

  private emit() {
    if (!this.disposed)
      this.listeners.forEach((listener) => listener(this.state));
  }
  dispose() {
    this.disposed = true;
    ++this.bgmRevision;
    this.cancelFade();
    this.stops.forEach((stop) => stop());
    this.listeners.clear();
    this.bgm.pause();
    this.bgm.removeAttribute("src");
    this.bgm.load();
    document.removeEventListener("pointerdown", this.gesture, true);
    document.removeEventListener("keydown", this.gesture, true);
  }
}
