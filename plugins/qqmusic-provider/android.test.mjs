import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { createHarness } from '../../sdk/android/harness.mjs'

const ROOT = path.dirname(fileURLToPath(import.meta.url))

function text(value) {
  const bytes = Buffer.from(value)
  const size = Buffer.alloc(2)
  size.writeUInt16BE(bytes.length)
  return Buffer.concat([size, bytes])
}

function packet(type, body) {
  const size = []
  let remaining = body.length
  do {
    const byte = remaining % 128
    remaining = Math.floor(remaining / 128)
    size.push(byte | (remaining ? 128 : 0))
  } while (remaining)
  return Buffer.concat([Buffer.from([type, ...size]), body])
}

test('Android completes a QQ Music app login with a long account ID without BigInt', async () => {
  const uin = '1152921504606846977'
  const requests = []
  const properties = Buffer.concat([Buffer.from([0x26]), text('type'), text('cookies')])
  const event = packet(0x30, Buffer.concat([
    text('management.qrcode_login/android-qr'), Buffer.from([properties.length]), properties,
    Buffer.from(JSON.stringify({ cookies: {
      qqmusic_uin: { value: uin }, qqmusic_key: { value: 'qr-ticket' }, tmeLoginType: { value: '1' }
    } }))
  ]))
  const harness = await createHarness(ROOT, {
    settings: { disclaimer: { disclaimerVersion: 'qqmusic-v1' } },
    routes(request) {
      const raw = request.body.toString('utf8')
      const body = JSON.parse(raw)
      let data
      if (request.url === 'https://api.tencentmusic.com/tme/trpc/proxy') {
        return { body: JSON.stringify({ code: 0, data: { q16: 'q16-test', q36: 'q36-test' } }) }
      }
      requests.push(body.req_0.method)
      switch (body.req_0.method) {
        case 'GetSession': data = { session: { uid: 'device-uid', sid: 'device-sid' } }; break
        case 'CreateQRCode': data = { qrcodeID: 'android-qr', qrcode: 'iVBORw0KGgo=', expiresIn: 180 }; break
        case 'Login':
          assert.match(raw, new RegExp(`"musicid":${uin}[,}]`))
          assert.equal(body.comm.tmeLoginType, 6)
          data = { musicid: Number(uin), str_musicid: uin, musickey: 'account-key' }
          break
        case 'GetLoginUserInfo':
          assert.equal(body.comm.qq, uin)
          assert.equal(body.comm.tmeLoginType, 1)
          data = { info: { nick: 'Android 用户' } }
          break
        default: assert.fail(`Unexpected method: ${body.req_0.method}`)
      }
      return { body: JSON.stringify({ code: 0, req_0: { code: 0, data } }) }
    },
    webSockets: () => ({
      open: socket => socket.emit({ type: 'open', protocol: 'mqtt' }),
      send(bytes, socket) {
        const type = bytes[0] >> 4
        const send = value => socket.emit({ type: 'message', binary: value.toString('base64') })
        if (type === 1) send(Buffer.from([0x20, 3, 0, 0, 0]))
        if (type === 8) {
          send(Buffer.from([0x90, 4, 0, 1, 0, 0]))
          send(event)
        }
      }
    })
  })
  try {
    harness.activate()
    const qr = harness.call('getQrLogin')
    assert.match(qr.imageDataUrl, /^data:image\/png;base64,/)
    assert.equal(harness.call('checkQrLogin', qr.key).code, 0)
    assert.equal(harness.call('checkLogin').profile.userId, uin)
    assert.equal(harness.host.settings.auth.credential.loginType, 1)
    assert.deepEqual(requests, ['GetSession', 'CreateQRCode', 'Login', 'GetLoginUserInfo'])
    harness.deactivate()
    harness.activate()
    assert.equal(harness.call('checkLogin').profile.userId, uin)
  } finally {
    await harness.close()
  }
})
