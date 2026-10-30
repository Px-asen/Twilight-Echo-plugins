# Android 插件 SDK（ABI v2）

把桌面音源插件（`index.mjs`）原样运行在 Android 插件宿主里。同一个 `.tep` 同时包含桌面入口和 Android 脚本，插件 ID、版本和设置不分叉。

Android 只运行音源（`type` 为 `["provider"]` 或 `["provider", "ui"]`）。其它插件不声明 `androidRuntime`，在手机的插件列表里显示为“移动端不适配”。

## 组成

| 文件 | 作用 |
| --- | --- |
| `runtime/` | 在 QuickJS 2020 里补齐桌面代码依赖的全局对象：`fetch`、`URL`、`TextEncoder`、`Buffer`、`WebSocket`、`crypto`、计时器、ES2021+ 内置方法。 |
| `node/` | Node 内置模块垫片：`http`（虚拟回环服务器）、`stream`、`events`、`zlib`、`crypto`、`fs`（空文件系统）等。没有的模块在构建时报错或在调用时抛出“在 Android 上不可用”。 |
| `provider.js` | `defineAndroidProvider()`：把桌面插件的 `activate(context)` 适配为 ABI v2。 |
| `build.mjs` | 用 esbuild 把 `android.mjs` 打成单个 IIFE 脚本，并校验 `androidRuntime`。 |
| `harness.mjs` | Node 里的参考宿主：在去掉 ES2021+ 内置对象的 `vm` 上下文里运行脚本，实现全部宿主 API 和授权检查。 |

## 给音源加 Android 版本

1. 在插件目录写 `android.mjs`：

   ```js
   import { defineAndroidProvider } from '../../sdk/android/provider.js'
   import * as plugin from './index.mjs'

   defineAndroidProvider(plugin)
   ```

2. 在 `plugin.json` 声明 `androidRuntime`：

   ```json
   "androidRuntime": {
     "apiVersion": 2,
     "entry": "android/provider.js",
     "permissions": ["network", "settings"],
     "networkHosts": ["api.example.com"],
     "mediaHosts": ["*.example-cdn.com"],
     "cleartextHosts": [],
     "userServer": false
   }
   ```

3. 更新插件版本后打包：`node scripts/pack-plugin.cjs <plugin-dir>`。打包脚本把 `android.mjs` 构建到 `androidRuntime.entry`，`android.mjs` 本身不进包。`sdk/android/android.test.mjs` 会核对每个包里的脚本与当前源码的构建结果一致；修改插件、`android.mjs` 或 SDK 后都要重新打包。

只看构建结果：`pnpm run build:android plugins/<plugin-dir> --out <file>`（加 `--no-minify` 便于阅读）。

### `androidRuntime` 字段

| 字段 | 规则 |
| --- | --- |
| `apiVersion` | 固定为 `2`。`1` 是内置网易云使用的串行 ABI。 |
| `entry` | 包内相对路径，只含字母、数字、`_`、`-` 和 `/`，以 `.js` 结尾。 |
| `permissions` | 只能是 `network`、`settings`。 |
| `networkHosts` | 插件可以请求的精确主机名，最多 48 个，不允许通配符和 IP。 |
| `mediaHosts` | 图片和音频 CDN，最多 32 个；可写 `*.example.com` 表示其全部子域。 |
| `cleartextHosts` | 允许明文 HTTP 的精确主机名，最多 16 个，每个都必须已被 `networkHosts` 或 `mediaHosts` 授权。 |
| `userServer` | 为 `true` 时，用户在登录表单填写的服务器源（协议 + 主机 + 端口）被授权，可以是局域网地址和 HTTP，用于 Navidrome、Jellyfin 这类自建服务。没有 `userServer` 时 `networkHosts` 不能为空。 |

宿主只放行 HTTPS。对 `networkHosts`／`mediaHosts` 里的主机，`http://` 地址会自动升级为 `https://`（脚本里的 `fetch` 和播放地址，宿主的封面与音频加载器同样处理），`cleartextHosts` 里的主机除外。每次重定向都会重新检查授权，跨源重定向会去掉 `Authorization`。

### `defineAndroidProvider(plugin, options)`

| 选项 | 作用 |
| --- | --- |
| `setup(context)` | 在 `plugin.activate(context)` 之前运行。 |
| `methods: { name: fn \| null }` | 替换（或用 `null` 删除）音源方法。 |
| `exclude: [name]` | 删除音源方法。 |
| `ui: {...}` | 合并到音源的 `ui` 提示。 |
| `commands` | `{ name: fn \| null }`，或 `({ runCommand, registered }) => ({...})`。`registered(name)` 始终返回插件自己注册的处理函数，即使同名命令已被 Android 版本替换，所以可以包装原命令。 |
| `panels(panels)` | 调整设置面板；没有对应命令的面板会被移除。 |

适配器的行为：

- 调用参数补齐到桌面渲染器的参数个数（`PROVIDER_ARITY`），最后一个参数是 `{ signal, idempotencyKey }`。多余的参数保留，供 `ui.streamingSections` 这类带参调用使用。
- 桌面插件返回的 `http://127.0.0.1:<port>/…` 代理地址（插件内置的 HTTP 服务）不会被请求：适配器用一个伪请求运行代理处理函数，截获它发往 CDN 的请求，把 URL 和请求头（去掉 `Range` 等）交给播放器，由播放器自己打开。结果里的回环封面地址同样替换为上游地址。
- `getQrLogin` 只返回 `qrContent` 时，由宿主生成二维码图片（`imageDataUrl`）。
- `context.twilight.ui.notify()` 的提示随调用结果返回（`notices`，每次最多 8 条）。
- 浏览器窗口、下载和云盘上传等桌面流程（`openOfficialLogin`、`createDownload`、`prepareCloudUpload` 等）不会暴露给 Android。

音源可以在 `ui` 里给出手机界面提示，例如 `qrStatusCodes`（`waiting`、`scanned`、`expired`、`denied`、`success` 对应的状态码）、`showBrowserButton`（二维码登录时显示“打开链接”）和 `streamingSections`。

## ABI v2

脚本加载后设置：

```js
globalThis.__TWILIGHT_PLUGIN__ = { apiVersion: 2, invoke(requestJson) /* → envelopeJson */ }
```

`invoke` 是同步的：它驱动插件自己的事件循环，直到请求完成或到达期限（默认 40 秒，`deadlineMs` 最多 50 秒）。请求：

| `operation` | 字段 | 结果 |
| --- | --- | --- |
| `activate` | `manifest` | `{ apiVersion, id, name, capabilities, methods, ui, panels }` |
| `call` | `method`, `args` | 方法返回值；`getPlaybackUrl` 规范化为 `{ url, headers } \| null` |
| `command` | `command`, `args` | 命令返回值，例如 `settings-form` |
| `resolveMedia` | `url`, `kind`（`stream`／`image`） | `{ url, headers } \| null`，把回环代理地址解析为上游请求 |
| `deactivate` | | `null` |
| `ping` | | `"pong"` |

返回 `{ ok: true, value, notices? }` 或 `{ ok: false, error }`。所有请求都可以带 `deadlineMs` 和 `idempotencyKey`。

## 宿主 API

脚本通过同步的 `__PLUGIN_HOST__.call(method, argsJson)` 访问宿主，返回 `{ ok, value }` 或 `{ ok: false, error }` 的 JSON。二进制数据一律用 base64。

| 方法 | 参数 → 结果 |
| --- | --- |
| `http.request` | `{ url, method, headers: [[name, value]], text? \| body?, redirect: 'follow' \| 'manual' }` → `{ status, statusText, url, redirected, headers, encoding: 'utf8' \| 'base64', body? \| bodyId? }`。宿主去掉 `Host`、`Connection`、`Content-Length`、`Accept-Encoding`、`Proxy-*` 等请求头，自己解压响应；跟随最多 5 次重定向；响应最多 8 MiB。 |
| `http.body` | `{ id, offset }` → `{ data, done }`。超过 128K 字符的响应体分段读取。 |
| `ws.open` | `{ url, protocols, headers }` → `{ id }`，只允许 `wss:`（用户服务器可用 `ws:`）。 |
| `ws.send` | `{ id, text? \| binary? }` |
| `ws.close` | `{ id, code, reason }` |
| `ws.poll` | `{ ids, timeoutMs ≤ 2000 }` → `[{ id, type: 'open' \| 'message' \| 'error' \| 'close', protocol?, text?, binary?, message?, code?, reason? }]` |
| `crypto.random` | `{ size ≤ 65536 }` → base64 |
| `crypto.hash` | `{ algorithm, data }`，`md5`、`sha1`、`sha224`、`sha256`、`sha384`、`sha512` |
| `crypto.hmac` | `{ algorithm, key, data }` |
| `crypto.cipher` | `{ algorithm: aes-(128\|192\|256)-(ecb\|cbc\|ctr\|gcm), key, iv, data, decrypt, padding, aad?, authTag?, authTagLength? }` → `{ data, authTag? }` |
| `crypto.publicEncrypt` | `{ key: PEM, padding: 1 (PKCS#1) \| 3 (无填充) \| 4 (OAEP), oaepHash, data }` |
| `crypto.pbkdf2` | `{ password, salt, iterations ≤ 1000000, keyLength ≤ 1024, digest }` |
| `zlib.process` | `{ mode: gzip \| gunzip \| deflate \| inflate \| deflateRaw \| inflateRaw \| unzip, data, level? }`。没有 Brotli；输出最多 8 MiB，超出时抛错。 |
| `qrImage` | `{ text ≤ 2048 }` → PNG data URL |
| `sleep` | `{ ms ≤ 2000 }` |
| `log` | `{ level: debug \| info \| warn \| error, message }` |
| `settings.get` / `settings.set` / `settings.delete` | `{ key?, value? }`，需要 `settings` 权限；整个设置对象序列化后不超过 256000 字符。 |

## 测试

```js
import { createHarness } from '../../sdk/android/harness.mjs'

const harness = await createHarness('plugins/navidrome-provider', {
  routes: (request) => ({ status: 200, headers: { 'content-type': 'application/json' }, body: '{}' }),
  network: false,            // true：没有路由的请求走真实网络
  webSockets: (url) => ({ open(socket) { socket.emit({ type: 'open' }) }, send(text, socket) {} }),
  settings: {}               // 初始设置
})
harness.host.grantUserServer('http://192.168.1.10:4533')  // 模拟用户在登录表单填写服务器
harness.activate()
harness.call('searchSongs', '关键词')
harness.host.requests         // 已发出的请求（授权检查之后）
await harness.close()
```

`harness.invoke(request)` 返回原始信封，`harness.resolveMedia(url, kind)` 测试代理地址解析。

## 限制

- 脚本最多 4,000,000 字符；插件进程内存上限 96 MiB，单次调用最长 60 秒。
- 没有真实文件系统：`fs` 是插件进程内的内存文件系统，读取包里的文件会得到 `ENOENT`。也没有子进程、`worker_threads`、`tls`、原生模块和动态下载代码。
- `node:http` 服务器不监听真实端口，只能被同一插件里的 `fetch` 和上面的代理解析访问。
- QuickJS 没有 `Intl`；`WeakRef` 是强引用。
