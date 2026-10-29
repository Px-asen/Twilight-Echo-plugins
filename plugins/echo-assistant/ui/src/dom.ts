const glyphs: Record<string, string> = {
  plus: '<path d="M12 5v14M5 12h14"/>', history: '<path d="M3 11a9 9 0 1 1 2.6 7M3 4v7h7M12 7v5l3 2"/>', settings: '<path d="M4 7h16M4 17h16M8 4v6m8 4v6"/>', close: '<path d="m6 6 12 12M6 18 18 6"/>', send: '<path d="m5 12 7-7 7 7M12 5v14"/>', stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>', check: '<path d="m5 12 4 4L19 6"/>', copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V4H4v12h4"/>', quality: '<path d="M4 5h16v15H4zM8 2v5m8-5v5M8 12h8m-8 4h5"/>', duplicates: '<rect x="8" y="8" width="12" height="13" rx="3"/><path d="M16 8V3H3v13h5"/>', playlist: '<path d="M4 6h11M4 11h11M4 16h7m7-6v9m0-8 4-1"/><ellipse cx="15.5" cy="19" rx="2.5" ry="2"/>', sound: '<path d="M4 10v4m4-7v10m4-14v18m4-14v10m4-7v4"/>', edit: '<path d="m14 5 5 5M4 20l5-1L21 7l-5-5L4 14z"/>', down: '<path d="M12 4v16m-6-6 6 6 6-6"/>', trash: '<path d="M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7"/>', arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>'
}
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag); node.className = cls
  if (text !== undefined) node.textContent = text
  return node
}
export function icon(name: string): SVGElement {
  const node = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  node.setAttribute('viewBox', '0 0 24 24'); node.setAttribute('aria-hidden', 'true'); node.innerHTML = glyphs[name] ?? glyphs.sound; return node
}
let reportError: (error: unknown) => void = error => console.error(error)
export function setErrorHandler(handler: typeof reportError): void { reportError = handler }
export function button(text: string, cls: string, action: () => unknown, glyph?: string): HTMLButtonElement {
  const node = el('button', cls); node.type = 'button'
  if (glyph) node.append(icon(glyph))
  if (text) node.append(el('span', '', text))
  node.addEventListener('click', () => { Promise.resolve().then(action).catch(reportError) }); return node
}
export function iconButton(label: string, glyph: string, action: () => unknown): HTMLButtonElement {
  const node = button('', 'icon-btn', action, glyph); node.title = label; node.setAttribute('aria-label', label); return node
}
let fieldSequence = 0
export function field(label: string, value: string, change: (value: string) => void, options: { multiline?: boolean; type?: string; hint?: string } = {}): HTMLElement {
  const wrap = el('div', 'field'), caption = el('label', 'field-label', label)
  const input = options.multiline ? el('textarea', 'form-input prompt-input') : el('input', 'form-input')
  input.id = `field-${++fieldSequence}`; caption.htmlFor = input.id; wrap.append(caption)
  if (input instanceof HTMLInputElement) input.type = options.type || 'text'
  input.value = value; input.addEventListener('input', () => change(input.value)); wrap.append(input)
  if (options.hint) { const hint = el('span', 'field-hint', options.hint); hint.id = `${input.id}-hint`; input.setAttribute('aria-describedby', hint.id); wrap.append(hint) }; return wrap
}
export function selectField(label: string, value: string, options: Array<[string, string]>, change: (value: string) => void): HTMLElement {
  const wrap = el('div', 'field'), caption = el('label', 'field-label', label)
  const select = el('select', 'form-input')
  select.id = `field-${++fieldSequence}`; caption.htmlFor = select.id; wrap.append(caption)
  for (const [id, name] of options) { const option = el('option', '', name); option.value = id; option.selected = id === value; select.append(option) }
  select.addEventListener('change', () => change(select.value)); wrap.append(select); return wrap
}
export function formatTokens(value: number): string { return value >= 1000000 ? `${(value / 1000000).toFixed(1)}M` : value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value) }

let root: HTMLElement, restoreFocus: HTMLElement | null = null
const inertBefore = new Map<HTMLElement, boolean>()
export function mountModals(target: HTMLElement): void { root = target }
export function closeModal(): void {
  root.textContent = ''
  for (const [node, inert] of inertBefore) node.inert = inert
  inertBefore.clear(); restoreFocus?.focus(); restoreFocus = null
}
export function sheet(title: string): { body: HTMLElement; panel: HTMLElement } {
  if (!root.childElementCount) {
    restoreFocus = document.activeElement as HTMLElement
    for (const node of root.parentElement?.children ?? []) if (node !== root && node instanceof HTMLElement && node.getAttribute('role') !== 'alert') { inertBefore.set(node, node.inert); node.inert = true }
  }
  root.textContent = ''
  const overlay = el('div', 'modal-overlay'), panel = el('section', 'sheet')
  panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-modal', 'true'); panel.setAttribute('aria-label', title); panel.tabIndex = -1
  const heading = el('header', 'sheet-heading'); heading.append(el('h2', '', title), iconButton('关闭', 'close', closeModal))
  const body = el('div', 'sheet-body'); panel.append(heading, body); overlay.append(panel); root.append(overlay)
  overlay.addEventListener('click', event => { if (event.target === overlay) closeModal() })
  panel.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); closeModal(); return }
    if (event.key !== 'Tab') return
    const controls = [...panel.querySelectorAll<HTMLElement>('button:not(:disabled),input,textarea,select,[tabindex="0"]')].filter(node => !node.hidden)
    if (!controls.length) return
    if (event.shiftKey && (document.activeElement === controls[0] || document.activeElement === panel)) { event.preventDefault(); controls.at(-1)!.focus() }
    else if (!event.shiftKey && document.activeElement === controls.at(-1)) { event.preventDefault(); controls[0].focus() }
  })
  requestAnimationFrame(() => panel.focus()); return { body, panel }
}
