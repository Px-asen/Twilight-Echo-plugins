/** The only transport between the packaged UI and Twilight Echo. */
export const isHosted = window.parent !== window;
type Pending = {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};
const pending = new Map<number, Pending>();
const listeners = new Map<string, Set<(value: any) => void>>();
let port: MessagePort | undefined;
let serial = 0;
let preferences: Record<string, string> = {};
let savedPreferences: Record<string, unknown> = {};
let preferenceTimer: ReturnType<typeof setTimeout> | undefined;
export let initialPlayer: any;

export function onHost(event: string, callback: (value: any) => void) {
  const callbacks = listeners.get(event) ?? new Set();
  callbacks.add(callback);
  listeners.set(event, callbacks);
  return () => {
    callbacks.delete(callback);
  };
}
export function callHost<T = any>(
  method: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  if (!port) return Promise.reject(new Error("Twilight Echo 尚未连接"));
  const id = ++serial;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`操作超时：${method}`));
    }, 30000);
    pending.set(id, { resolve, reject, timer });
    port!.postMessage({ id, method, args });
  });
}
export async function connectHost() {
  if (!isHosted) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      window.removeEventListener("message", receive);
      reject(
        new Error("无法连接宿主，请更新至支持完整界面 bridge v2 的版本。"),
      );
    }, 20000);
    function receive(event: MessageEvent) {
      if (
        event.source !== window.parent ||
        event.data?.type !== "twilight-experience-connect"
      )
        return;
      if (event.data.bridgeVersion !== 2 || !event.ports[0]) return;
      clearTimeout(timer);
      window.removeEventListener("message", receive);
      port = event.ports[0];
      port.onmessage = ({ data }) => {
        if (data?.event) {
          listeners
            .get(data.event)
            ?.forEach((callback) => callback(data.value));
          return;
        }
        const request = pending.get(data?.id);
        if (!request) return;
        clearTimeout(request.timer);
        pending.delete(data.id);
        if (data.error) request.reject(new Error(data.error));
        else request.resolve(data.value);
      };
      port.start();
      resolve();
    }
    window.addEventListener("message", receive);
    window.parent.postMessage(
      { type: "twilight-experience-ready", bridgeVersion: 2 },
      "*",
    );
  });
  const [saved, state] = await Promise.all([
    callHost("preferences.read"),
    callHost("player.state"),
  ]);
  savedPreferences = saved && typeof saved === "object" ? saved : {};
  preferences =
    savedPreferences.localPreferences &&
    typeof savedPreferences.localPreferences === "object"
      ? (savedPreferences.localPreferences as Record<string, string>)
      : {};
  const capabilities = await callHost("host.capabilities");
  if (
    capabilities.bridgeVersion !== 2 ||
    ![
      "music.library",
      "radio.list",
      "podcasts.list",
      "network.profiles",
      "stats.read",
      "player.sleep",
    ].every((method) => capabilities.methods.includes(method))
  )
    throw new Error("宿主缺少音乐界面所需能力，请更新 Twilight Echo。");
  initialPlayer = state;
}
export function preferenceGet(key: string): string | null {
  return isHosted ? (preferences[key] ?? null) : localStorage.getItem(key);
}
export function preferenceSet(key: string, value: string) {
  if (!isHosted) {
    localStorage.setItem(key, value);
    return;
  }
  preferences[key] = value;
  clearTimeout(preferenceTimer);
  preferenceTimer = setTimeout(
    () =>
      void callHost("preferences.write", {
        value: { ...savedPreferences, localPreferences: preferences },
      }).catch(reportHostError),
    150,
  );
}
export function reportHostError(error: unknown) {
  window.dispatchEvent(
    new CustomEvent("rhine-host-error", {
      detail: error instanceof Error ? error.message : String(error),
    }),
  );
}
const routes: Record<string, string> = {
  "/api/library": "music.library",
  "/api/library/scan": "music.scan",
  "/api/config": "music.config",
  "/api/library/config": "music.config",
  "/api/genre-rules": "music.genres",
  "/api/library/enrich": "music.enrich",
  "/api/library/introductions": "music.introductions",
  "/api/library/credits": "music.credits",
  "/api/library/introductions/task": "music.introductionTask",
  "/api/library/introductions/import-preview": "music.introductionPreview",
  "/api/library/introductions/import": "music.introductionImport",
  "/api/library/introductions/reconcile": "music.introductionReconcile",
};
export async function hostRequest<T>(url: string, body?: unknown): Promise<T> {
  const parsed = new URL(url, "https://rhine.invalid");
  const method = routes[parsed.pathname];
  if (!method) throw new Error(`不支持的音乐操作：${parsed.pathname}`);
  const { musicRequest } = await import("./music-api");
  return musicRequest<T>(parsed, body);
}
window.addEventListener("pagehide", () => {
  clearTimeout(preferenceTimer);
  if (isHosted && port)
    port.postMessage({
      id: ++serial,
      method: "preferences.write",
      args: { value: { ...savedPreferences, localPreferences: preferences } },
    });
  pending.forEach((request) => {
    clearTimeout(request.timer);
    request.reject(new Error("界面已关闭"));
  });
  pending.clear();
  listeners.clear();
  port?.close();
  port = undefined;
});
