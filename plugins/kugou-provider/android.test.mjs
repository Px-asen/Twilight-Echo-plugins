import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { createHarness } from '../../sdk/android/harness.mjs'

const ROOT = path.dirname(fileURLToPath(import.meta.url))

test('Android runs embedded QR login and playback without V8 or BigInt', async () => {
  const harness = await createHarness(ROOT, {
    settings: { device: { platform: 'lite', dfid: 'fixture-dfid' } },
    routes(request) {
      const url = new URL(request.url)
      let body
      switch (url.origin + url.pathname) {
        case 'https://login-user.kugou.com/v2/qrcode':
          body = { error_code: 0, status: 1, data: { qrcode: 'fixture-qr-key' } }
          break
        case 'https://login-user.kugou.com/v2/get_userinfo_qrcode':
          body = { error_code: 0, status: 1, data: { status: 4, token: 'fixture-token', userid: '123' } }
          break
        case 'https://gateway.kugou.com/v3/get_my_info':
          body = { error_code: 0, status: 1, data: { userid: 123, nickname: 'Fixture' } }
          break
        case 'https://gateway.kugou.com/v5/url':
          body = { error_code: 0, status: 1, url: ['https://fs.kugou.com/fixture.mp3'] }
          break
        default:
          assert.fail(`Unexpected upstream request: ${url.origin}${url.pathname}`)
      }
      return {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      }
    }
  })
  const hostCall = harness.host.call.bind(harness.host)
  harness.host.call = (method, args) => method === 'crypto.random' && args.size === 8
    ? Buffer.alloc(8, 255).toString('base64')
    : hostCall(method, args)
  try {
    harness.activate()
    assert.throws(() => harness.call('getQrLogin'), /阅读并确认免责声明/)
    assert.equal(harness.host.requests.length, 0)
    const settings = harness.command('kugou.settings', { disclaimer: 'kugoumusic-v1' })
    assert.deepEqual(settings.form.fields.map((field) => field.key), ['disclaimer'])
    const qr = harness.call('getQrLogin')
    assert.equal(qr.key, 'fixture-qr-key')
    assert.equal(qr.expiresInSeconds, 180)
    assert.match(qr.imageDataUrl, /^data:image\/png;base64,/)
    const png = Buffer.from(qr.imageDataUrl.split(',')[1], 'base64')
    assert.equal(png.subarray(1, 4).toString(), 'PNG')
    assert.ok(png.readUInt32BE(16) >= 100)
    assert.equal(png.readUInt32BE(16), png.readUInt32BE(20))
    assert.equal(harness.host.requests.length, 1)
    const identity = harness.host.settings.device
    assert.equal(identity.webgl, '18446744073709551615')
    assert.equal(harness.call('checkQrLogin', qr.key).code, 4)
    assert.equal(harness.call('checkLogin').loggedIn, true)
    assert.deepEqual(harness.call('getPlaybackUrl', { id: 'kugou:ABCD' }, {}), {
      url: 'https://fs.kugou.com/fixture.mp3', headers: []
    })
    // Resolving the playback proxy captures the CDN request without opening it.
    assert.equal(harness.host.requests.some((request) => new URL(request.url).hostname === 'fs.kugou.com'), false)
    const logs = JSON.stringify(harness.host.logs)
    assert.equal(logs.includes('fixture-qr-key'), false)
    assert.equal(logs.includes('fixture-token'), false)
    // Identity survives unloading/restarting the embedded service.
    harness.deactivate()
    harness.activate()
    harness.call('getQrLogin')
    assert.equal(harness.host.settings.device.webgl, identity.webgl)
    assert.equal(harness.host.settings.device.guid, identity.guid)
  } finally {
    await harness.close()
  }
})
