import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DIY_FIELDS,
  RESET_SETTINGS_COMMAND,
  SAVE_SETTINGS_COMMAND,
  buildDiyForm,
  parseDiyValues
} from './config.mjs'

export const DEFAULT_CONFIG = {
  appearance: {
    backgroundColor: '#000000',
    backgroundOpacity: 100,
    textColor: '#ffffff',
    accentColor: '#ff8fb6',
    accentSource: 'custom',
    visualizerColor: '#a89de3',
    fontScale: 100,
    collapsedRadius: 25,
    expandedRadius: 58,
    audioReactive: true
  },
  layout: {
    collapsedWidth: 250,
    collapsedHeight: 48,
    expandedWidth: 430,
    anchor: 'center',
    offsetX: 0,
    offsetY: 12,
    display: 'main-window'
  },
  components: {
    collapsedContent: 'artwork',
    cover: true,
    visualizer: true,
    lyric: true,
    progress: true,
    time: true,
    favorite: true,
    skip: true,
    volume: true
  },
  behavior: {
    expandTrigger: 'hover',
    collapseDelayMs: 420,
    motion: 'normal',
    visibility: 'always'
  }
}

test('DIY form covers every config value in four live, resettable groups', () => {
  const form = buildDiyForm(DEFAULT_CONFIG)
  assert.equal(form.kind, 'settings-form')
  assert.equal(form.submitCommand, SAVE_SETTINGS_COMMAND)
  assert.equal(form.resetCommand, RESET_SETTINGS_COMMAND)
  assert.equal(form.live, true)
  assert.ok(form.fields.length <= 40)
  const configKeys = Object.entries(DEFAULT_CONFIG).flatMap(([section, values]) =>
    Object.keys(values).map((name) => `${section}.${name}`)
  )
  assert.deepEqual(form.fields.map((field) => field.key).sort(), configKeys.sort())
  assert.deepEqual(
    [...new Set(form.fields.map((field) => field.group))],
    ['外观', '布局与尺寸', '显示的组件', '交互行为']
  )
})

test('form values parse into a typed patch without accepting unknown keys', () => {
  const patch = parseDiyValues(DEFAULT_CONFIG, {
    'appearance.audioReactive': 'false',
    'appearance.accentColor': '#123456',
    'layout.expandedWidth': '500',
    'layout.offsetX': '',
    'behavior.collapseDelayMs': 'abc',
    'components.volume': 'false',
    'unknown.key': 'x'
  })
  assert.equal(patch.appearance.audioReactive, false)
  assert.equal(patch.appearance.accentColor, '#123456')
  assert.equal(patch.layout.expandedWidth, 500)
  assert.equal(patch.layout.offsetX, 0)
  assert.equal(patch.behavior.collapseDelayMs, 420)
  assert.equal(patch.components.volume, false)
  assert.equal('unknown' in patch, false)
})

test('round-tripping the form is lossless and range declarations are bounded', () => {
  const values = Object.fromEntries(
    buildDiyForm(DEFAULT_CONFIG).fields.map((field) => [field.key, field.value])
  )
  assert.deepEqual(parseDiyValues(DEFAULT_CONFIG, values), DEFAULT_CONFIG)
  for (const field of DIY_FIELDS) {
    if (field.spec.type === 'range') assert.ok(field.spec.min < field.spec.max, field.name)
  }
})
