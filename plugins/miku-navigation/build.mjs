import { palette } from './palette.mjs'
import { createEditor } from './editor.mjs'
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const root = new URL('./', import.meta.url)
const icons = JSON.parse(await readFile(new URL('icons.json', root), 'utf8'))
const navigationIcons = icons.filter((icon) => !icon.group)
const settingsIcons = icons.filter((icon) => icon.group === 'settings')
const streamingIcons = icons.filter((icon) => icon.group === 'streaming')
const imageSelector = (icon) =>
  icon.group === 'settings' ? `${icon.selector}::after` : icon.selector
const rules = [
  `${icons.map(imageSelector).join(',\n')} {\n  background-position: center;\n  background-repeat: no-repeat;\n  background-size: contain;\n}`,
  `${navigationIcons.map((icon) => icon.selector).join(',\n')} {\n  scale: calc(28 / 22);\n}`,
  `${streamingIcons.map((icon) => icon.selector).join(',\n')} {\n  scale: calc(28 / 17);\n}`,
  `${settingsIcons.map((icon) => icon.selector).join(',\n')} {\n  position: relative;\n}`,
  `${settingsIcons.map(imageSelector).join(',\n')} {\n  content: '';\n  position: absolute;\n  top: 50%;\n  left: 50%;\n  width: 36px;\n  height: 36px;\n  transform: translate(-50%, -50%);\n  pointer-events: none;\n}`,
  `${settingsIcons.map((icon) => `${icon.selector}::before`).join(',\n')} {\n  visibility: hidden;\n}`
]

for (const [index, icon] of icons.entries()) {
  const data = await readFile(new URL(`icons/${icon.file}`, root))
  rules.push(
    `${imageSelector(icon)} {\n  background-image: var(--miku-icon-${index}, url('data:image/png;base64,${data.toString('base64')}'));\n}`
  )
}

const themeGlyphs = icons
  .filter((icon) => !icon.legacyGlyph)
  .map((icon) => `${icon.selector} > .theme-icon-glyph`)
rules.push(`${themeGlyphs.join(',\n')} {\n  display: none;\n}`)

for (const icon of icons.filter((entry) => entry.legacyGlyph && entry.group !== 'settings')) {
  rules.push(`${icon.selector}::before {\n  content: none;\n}`)
}

const stylesheet = new URL('theme.css', root)
const heroImage = await readFile(new URL('artwork/miku-home.jpg', root))
rules.push(
  `html {\n  --miku-hero-image: url('data:image/jpeg;base64,${heroImage.toString('base64')}');\n}`,
  await readFile(new URL('home.css', root), 'utf8')
)
const skyImage = await readFile(new URL('artwork/miku-sky.webp', root))
const bouquetImage = await readFile(new URL('artwork/miku-bouquet.webp', root))
rules.push(
  `html { --miku-wall-image: url('data:image/webp;base64,${bouquetImage.toString('base64')}'); --miku-library-image: url('data:image/webp;base64,${skyImage.toString('base64')}'); }`,
  await readFile(new URL('background.css', root), 'utf8')
)
rules.push(await readFile(new URL('colors.css', root), 'utf8'))
rules.push(await readFile(new URL('library.css', root), 'utf8'))
rules.push(await readFile(new URL('settings.css', root), 'utf8'))
for (const state of ['peek', 'listening', 'thinking', 'done', 'empty']) {
  const data = await readFile(new URL(`artwork/states/miku-${state}.webp`, root))
  rules.push(
    `html { --miku-state-${state}: url('data:image/webp;base64,${data.toString('base64')}'); }`
  )
}
rules.push(await readFile(new URL('states.css', root), 'utf8'))
rules.push(await readFile(new URL('chrome.css', root), 'utf8'))
const manifestUrl = new URL('plugin.json', root)
const manifest = JSON.parse(await readFile(manifestUrl, 'utf8'))
manifest.contributes.themes[0].editor = createEditor(icons)
manifest.contributes.themes[0].structured = {
  schemaVersion: 1,
  variants: { pureWhite: palette(false), dark: palette(true) }
}
await writeFile(manifestUrl, JSON.stringify(manifest, null, 2) + '\n')
const css = `${rules.map((rule) => rule.trimEnd()).join('\n\n')}\n`
await writeFile(stylesheet, css)
console.log(`Built ${icons.length} navigation icons: ${fileURLToPath(stylesheet)}`)
console.log(`CSS size: ${Buffer.byteLength(css)} bytes`)
