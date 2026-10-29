import test from 'node:test'
import assert from 'node:assert/strict'
import { configuredAccent, accessibleAccent, contrast } from '../src/theme.ts'

test('主题色使用宿主明暗独立设置，兼容旧字段和自定义颜色', () => {
  const settings = { accentColor: 'violet', lightAccentColor: 'blue', darkAccentColor: '#f08c18' }
  assert.equal(configuredAccent(settings, false), '#2563eb')
  assert.equal(configuredAccent(settings, true), '#f08c18')
  assert.equal(configuredAccent({ accentColor: 'rose' }, true), '#e11d48')
  assert.equal(configuredAccent({}, false), undefined)
})
test('强调色文本在深浅表面达到 4.5:1，保留已符合要求的颜色', () => {
  for (const surface of [[255, 255, 255], [30, 30, 30]]) for (const accent of [[245, 158, 11], [37, 99, 235], [16, 185, 129], [238, 238, 238]]) {
    assert.ok(contrast(accessibleAccent(accent, surface), surface) >= 4.5)
  }
  assert.deepEqual(accessibleAccent([37, 99, 235], [255, 255, 255]), [37, 99, 235])
})
