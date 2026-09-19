import assert from 'node:assert/strict'
import test from 'node:test'
import { activate } from './index.mjs'

async function fixture(run) {
  const calls = []
  const settings = new Map()
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input, options) => {
    options.signal.throwIfAborted()
    const url = new URL(input)
    calls.push({ url, options })
    if (url.pathname.endsWith('/AuthenticateByName')) {
      return Response.json({ AccessToken: 'fixture-token', User: { Id: 'u1', Name: 'Listener' } })
    }
    if (url.pathname.endsWith('/Users/u1')) return Response.json({ Id: 'u1', Name: 'Listener' })
    if (url.searchParams.get('IncludeItemTypes') === 'Playlist') {
      return Response.json({ Items: [{ Id: 'p1', Name: 'Playlist' }], TotalRecordCount: 1 })
    }
    const offset = Number(url.searchParams.get('StartIndex') || 0)
    const count = Math.min(Number(url.searchParams.get('Limit') || 100), 101 - offset)
    return Response.json({
      Items: Array.from({ length: count }, (_, index) => ({
        Id: String(offset + index),
        Type: 'Audio',
        Name: 'Song',
        Artists: ['Artist'],
        Album: 'Album',
        RunTimeTicks: 1800000000,
        ImageTags: { Primary: 'image-tag' }
      })),
      TotalRecordCount: 101
    })
  }
  let provider
  const context = {
    settings: {
      get: async (key) => settings.get(key),
      set: async (key, value) => settings.set(key, value),
      delete: async (key) => settings.delete(key)
    },
    twilight: {
      providers: {
        register: async (value) => {
          provider = value
        }
      }
    }
  }
  await activate(context)
  try {
    await run({
      provider,
      calls,
      settings,
      restart: async () => {
        await activate(context)
        return provider
      }
    })
  } finally {
    globalThis.fetch = originalFetch
  }
}

test('server login persists only the session and survives a host restart', async () =>
  fixture(async ({ provider, calls, settings, restart }) => {
    assert.equal((await provider.checkLogin()).loggedIn, false)
    await provider.loginWithServer(
      'https://fixture.invalid/jellyfin',
      'Listener',
      'fixture-password'
    )
    assert.equal(calls[0].url.pathname, '/jellyfin/Users/AuthenticateByName')
    assert.equal(JSON.parse(calls[0].options.body).Pw, 'fixture-password')
    assert.equal(JSON.stringify([...settings]).includes('fixture-password'), false)
    const restored = await restart()
    assert.equal((await restored.checkLogin()).profile.nickname, 'Listener')
    await restored.logout()
    assert.equal(settings.has('session'), false)
    await assert.rejects(restored.searchSongs('Song'), /请先连接/)
  }))

test('search and playlist pagination map tracks and preserve server-scoped identities', async () =>
  fixture(async ({ provider, calls }) => {
    await provider.loginWithServer(
      'https://fixture.invalid/jellyfin',
      'Listener',
      'fixture-password'
    )
    const page = await provider.searchSongs('歌曲 & title', 2, 10)
    assert.equal(page.total, 101)
    assert.equal(page.items.length, 2)
    assert.equal(page.items[0].duration, 180)
    assert.equal(calls.at(-1).url.searchParams.get('SearchTerm'), '歌曲 & title')
    assert.equal(calls.at(-1).url.searchParams.get('StartIndex'), '10')
    const stream = new URL(await provider.getPlaybackUrl(page.items[0]))
    assert.equal(stream.pathname, '/jellyfin/Audio/10/universal')
    assert.equal(stream.searchParams.get('api_key'), 'fixture-token')
    assert.equal(stream.searchParams.get('UserId'), 'u1')
    assert.equal(new URL(page.items[0].cover).pathname, '/jellyfin/Items/10/Images/Primary')
    assert.deepEqual(
      (await provider.fetchUserLibrary()).playlists.map((item) => item.id),
      ['@all', 'p1']
    )
    assert.equal((await provider.fetchPlaylistTracks('p1')).length, 101)
    assert.equal((await provider.fetchPlaylistTracks('@all')).length, 101)
    await assert.rejects(provider.getPlaybackUrl({ id: 'jellyfin:other:10' }), /另一台/)
  }))

test('failed login preserves the session and cancelled requests do not return media', async () =>
  fixture(async ({ provider, settings }) => {
    await provider.loginWithServer(
      'https://fixture.invalid/jellyfin',
      'Listener',
      'fixture-password'
    )
    const previous = settings.get('session')
    globalThis.fetch = async () => new Response('', { status: 401 })
    await assert.rejects(
      provider.loginWithServer('https://fixture.invalid/jellyfin', 'Listener', 'wrong'),
      /访问权限/
    )
    assert.equal(settings.get('session'), previous)
    await assert.rejects(provider.loginWithServer('file:///tmp', 'Listener', ''), /HTTP/)
    const controller = new AbortController()
    controller.abort(new Error('cancelled'))
    await assert.rejects(
      provider.getPlaybackUrl({ id: 'anything' }, {}, { signal: controller.signal }),
      /cancelled/
    )
  }))
