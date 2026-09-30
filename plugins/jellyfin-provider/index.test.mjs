import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { activate } from './index.mjs'

const manifest = JSON.parse(await readFile(new URL('./plugin.json', import.meta.url), 'utf8'))

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

test('manifest declares the permissions required by the registered library provider', async () =>
  fixture(async ({ provider }) => {
    assert.equal(provider.id, 'jellyfin')
    assert.ok(provider.capabilities.includes('library'))
    for (const permission of ['network', 'settings', 'library:read']) {
      assert.ok(manifest.permissions.includes(permission), `Missing ${permission} permission`)
    }
  }))

test('marketplace package and index match the source manifest and package checksum', async () => {
  const index = JSON.parse(await readFile(new URL('../../plugins.json', import.meta.url), 'utf8'))
  const entry = index.plugins.find((plugin) => plugin.id === manifest.id)
  assert.ok(entry)
  assert.equal(entry.version, manifest.version)
  assert.deepEqual(entry.permissions, manifest.permissions)
  assert.equal(entry.sourceUrl, `packages/${manifest.id}-${manifest.version}.tep`)
  const archive = new URL(`../../${entry.sourceUrl}`, import.meta.url)
  assert.equal(
    entry.checksumSha256,
    createHash('sha256')
      .update(await readFile(archive))
      .digest('hex')
  )
  const executable =
    process.platform === 'linux'
      ? 'unzip'
      : process.platform === 'win32'
        ? 'C:/Windows/System32/tar.exe'
        : 'tar'
  const args =
    process.platform === 'linux'
      ? ['-p', fileURLToPath(archive), 'plugin.json']
      : ['-xOf', fileURLToPath(archive), 'plugin.json']
  const { stdout } = await promisify(execFile)(executable, args)
  assert.deepEqual(JSON.parse(stdout), manifest)
})

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
