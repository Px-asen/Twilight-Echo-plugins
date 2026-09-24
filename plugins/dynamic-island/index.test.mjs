import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULT_CONFIG } from './fixture.mjs'
import { RESET_SETTINGS_COMMAND, SAVE_SETTINGS_COMMAND } from './config.mjs'
import { activate, deactivate } from './index.mjs'

function mergeConfig(input) {
  return {
    appearance: { ...DEFAULT_CONFIG.appearance, ...input.appearance },
    layout: { ...DEFAULT_CONFIG.layout, ...input.layout },
    components: { ...DEFAULT_CONFIG.components, ...input.components },
    behavior: { ...DEFAULT_CONFIG.behavior, ...input.behavior }
  }
}

test('activation registers the player button and live DIY settings panel', async () => {
  const settings = new Map()
  const commands = new Map()
  const contributions = []
  const overlayCalls = []
  const context = {
    settings: {
      get: async (key) => settings.get(key),
      set: async (key, value) => settings.set(key, value)
    },
    twilight: {
      overlay: {
        configure: async (input) => {
          overlayCalls.push(['configure', input])
          return mergeConfig(input)
        },
        show: async () => overlayCalls.push(['show']),
        hide: async () => overlayCalls.push(['hide'])
      },
      ui: {
        onCommand: (name, handler) => commands.set(name, handler),
        register: async (contribution) => contributions.push(contribution)
      }
    }
  }

  await activate(context)
  try {
    assert.deepEqual(
      contributions.map(({ id, kind }) => [id, kind]),
      [
        ['dynamic-island-toggle', 'playerBarButton'],
        ['dynamic-island-diy', 'settingsPanel']
      ]
    )
    assert.equal(contributions[1].autoLoad, true)
    assert.equal(overlayCalls.some(([method]) => method === 'show'), true)

    const form = await commands.get('dynamic-island.settings.open')()
    assert.equal(form.kind, 'settings-form')
    const result = await commands.get(SAVE_SETTINGS_COMMAND)({
      'layout.expandedWidth': '500',
      'components.volume': 'false'
    })
    assert.equal(result.form.fields.find((field) => field.key === 'layout.expandedWidth').value, '500')
    assert.equal(settings.get('config').layout.expandedWidth, 500)

    const reset = await commands.get(RESET_SETTINGS_COMMAND)()
    assert.equal(reset.message, '已恢复默认外观')
    assert.equal(await commands.get('dynamic-island.toggle')(), '灵动岛已隐藏')
  } finally {
    await deactivate()
  }
})
