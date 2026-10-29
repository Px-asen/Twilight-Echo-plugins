/** Use the host's existing appearance settings; the iframe keeps no palette preference. */
export interface AppearanceSettings { theme?: string; accentColor?: string; lightAccentColor?: string; darkAccentColor?: string; motionPreference?: string }
const namedColors: Record<string, string> = { violet: '#8b5cf6', blue: '#2563eb', emerald: '#10b981', rose: '#e11d48', amber: '#f59e0b', slate: '#334155' }
export function configuredAccent(settings: AppearanceSettings, dark: boolean): string | undefined {
  const value = (dark ? settings.darkAccentColor : settings.lightAccentColor) || settings.accentColor
  return value ? namedColors[value] || value : undefined
}
type Rgb = [number, number, number]
function luminance(rgb: Rgb): number {
  const channels = rgb.map(value => { const c = value / 255; return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4 })
  return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722
}
export function contrast(a: Rgb, b: Rgb): number { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05) }
export function accessibleAccent(accent: Rgb, background: Rgb): Rgb {
  if (contrast(accent, background) >= 4.5) return accent
  const target: Rgb = luminance(background) > .5 ? [0, 0, 0] : [255, 255, 255]
  for (let step = 1; step <= 100; step++) {
    const result = accent.map((value, i) => Math.round(value + (target[i] - value) * step / 100)) as Rgb
    if (contrast(result, background) >= 4.5) return result
  }
  return target
}
export function followAppearance(read: () => Promise<{ settings: AppearanceSettings }>, onError: (error: unknown) => void, surface: HTMLElement): () => void {
  const root = document.documentElement, media = matchMedia('(prefers-color-scheme: dark)')
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1
  const paint = canvas.getContext('2d', { willReadFrequently: true })!
  let settings: AppearanceSettings = {}, busy = false, disposed = false, reported = false
  let appearanceKey = '', appearanceFrame = 0
  const rgb = (color: string): Rgb => { paint.clearRect(0, 0, 1, 1); paint.fillStyle = color; paint.fillRect(0, 0, 1, 1); return Array.from(paint.getImageData(0, 0, 1, 1).data).slice(0, 3) as Rgb }
  const apply = () => {
    const theme = settings.theme === 'dark' ? 'dark' : settings.theme === 'pureWhite' ? 'light' : 'system'
    const dark = settings.theme === 'dark' || settings.theme !== 'pureWhite' && media.matches
    const value = configuredAccent(settings, dark)
    const nextKey = `${theme}:${dark}:${value ?? ''}`
    if (nextKey !== appearanceKey) {
      // Swap foregrounds and surfaces together; hover transitions must not cross themes.
      appearanceKey = nextKey
      root.dataset.appearanceChanging = 'true'
      cancelAnimationFrame(appearanceFrame)
      appearanceFrame = requestAnimationFrame(() => {
        appearanceFrame = requestAnimationFrame(() => { delete root.dataset.appearanceChanging; appearanceFrame = 0 })
      })
    }
    root.dataset.theme = theme
    if (value && CSS.supports('color', value)) {
      const accent = rgb(value), background = rgb(getComputedStyle(surface).backgroundColor)
      root.style.setProperty('--accent-solid', value)
      root.style.setProperty('--accent', `rgb(${accessibleAccent(accent, background).join(' ')})`)
      root.style.setProperty('--on-accent', contrast([255, 255, 255], accent) >= contrast([0, 0, 0], accent) ? '#ffffff' : '#000000')
    } else {
      for (const property of ['--accent-solid', '--accent', '--on-accent']) root.style.removeProperty(property)
    }
    if (settings.motionPreference) root.dataset.reducedMotion = String(['reduced', 'off'].includes(settings.motionPreference))
  }
  const refresh = async () => {
    if (disposed || busy || document.hidden) return
    busy = true
    try { settings = (await read()).settings; if (!disposed) apply(); reported = false }
    catch (error) { if (!disposed && !reported) { reported = true; onError(error) } }
    finally { busy = false }
  }
  media.addEventListener('change', apply)
  window.addEventListener('focus', refresh); document.addEventListener('visibilitychange', refresh)
  const timer = setInterval(refresh, 2000); void refresh()
  return () => { disposed = true; clearInterval(timer); cancelAnimationFrame(appearanceFrame); delete root.dataset.appearanceChanging; media.removeEventListener('change', apply); window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh) }
}
