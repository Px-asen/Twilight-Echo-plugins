/** Experience bridge v2: only the plugin process owns network and secrets. */
export type PluginEvent = { sessionId?: string; runId?: string; revision?: number; type: string; [key: string]: unknown }
import type { AppearanceSettings } from './theme'

export function createBridge(): Promise<{
  request: (payload: unknown) => Promise<unknown>
  environment: () => Promise<{ reducedMotion: boolean }>
  appearance: () => Promise<{ settings: AppearanceSettings }>
  onPluginEvent: (listener: (event: PluginEvent) => void) => () => void
  onLibraryChange: (listener: () => void) => () => void
  dispose: () => void
}> {
  return new Promise((resolve, reject) => {
    if (window.parent === window) { reject(new Error('请从 Twilight Echo 标题栏打开「回声助手」')); return }
    const timeout = setTimeout(() => {
      window.removeEventListener('message', onConnect)
      reject(new Error('等待宿主连接超时，请关闭面板后重试'))
    }, 8000)
    function onConnect(event: MessageEvent): void {
      if (event.source !== window.parent || event.data?.type !== 'twilight-experience-connect' || event.data.bridgeVersion !== 2 || !event.ports[0]) return
      clearTimeout(timeout)
      window.removeEventListener('message', onConnect)
      const port = event.ports[0]
      const listeners = new Set<(event: PluginEvent) => void>()
      const libraryListeners = new Set<() => void>()
      const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
      let sequence = 0, disposed = false
      port.addEventListener('message', message => {
        const data = message.data
        if (typeof data?.id === 'number' && pending.has(data.id)) {
          const entry = pending.get(data.id)!
          pending.delete(data.id)
          if ('error' in data) entry.reject(new Error(data.error))
          else entry.resolve(data.value ?? null)
          return
        }
        if (data?.event === 'library') { for (const listener of libraryListeners) listener(); return }
        if (data?.event !== 'plugin') return
        // The host wraps the named plugin event, then its chat payload.
        const payload = data.value?.event === 'chat' ? data.value.value : data.value
        if (payload && typeof payload.type === 'string') for (const listener of listeners) listener(payload)
      })
      const call = (method: string, args: Record<string, unknown>, timeoutMs = 20000): Promise<unknown> => {
        if (disposed) return Promise.reject(new Error('面板连接已关闭'))
        const id = ++sequence
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => { pending.delete(id); reject(new Error('请求超时，请检查插件运行状态')) }, timeoutMs)
          pending.set(id, {
            resolve: value => { clearTimeout(timer); resolve(value) },
            reject: error => { clearTimeout(timer); reject(error) }
          })
          port.postMessage({ id, method, args })
        })
      }
      const dispose = () => {
        disposed = true
        for (const entry of pending.values()) entry.reject(new Error('面板连接已关闭'))
        pending.clear(); listeners.clear(); libraryListeners.clear(); port.close()
      }
      port.addEventListener('messageerror', dispose)
      port.start()
      resolve({
        request: payload => call('plugin.request', { request: payload }, (payload as { type?: string })?.type === 'models.list' ? 30000 : 20000),
        environment: () => call('host.environment', {}) as Promise<{ reducedMotion: boolean }>,
        appearance: () => call('settings.read', {}) as Promise<{ settings: AppearanceSettings }>,
        onPluginEvent: listener => { listeners.add(listener); return () => listeners.delete(listener) },
        onLibraryChange: listener => { libraryListeners.add(listener); return () => libraryListeners.delete(listener) },
        dispose
      })
    }
    window.addEventListener('message', onConnect)
    window.parent.postMessage({ type: 'twilight-experience-ready', bridgeVersion: 2 }, '*')
  })
}
