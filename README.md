# Twilight Echo Plugins

This repository hosts the `plugins.json` directory used by Twilight Echo's in-app marketplace. Its `plugins/` and `packages/` folders contain plugins maintained here. Independent developers keep their source code, README, and release assets in their own public repositories.

## Publish an independent plugin

You do not need to fork this directory or submit a pull request for automatic discovery:

1. Create a public GitHub repository for your plugin. Keep its source and a README there. Set `plugin.json.repository` to its exact URL, for example `https://github.com/example/twilight-lyrics` (no trailing slash).
2. Build a `.tep` package with `plugin.json` at the archive root. Name it `<plugin-id>-<version>.tep`, matching the manifest exactly. See the [plugin development guide](https://github.com/Px-asen/Twilight_Echo/blob/Pxasen/docs/PLUGIN_README.md) for a complete manifest and packaging command.
3. Create a GitHub Release tagged `<version>` or `v<version>`. Attach **exactly one** `.tep` asset, no larger than 50 MiB. Add the repository Topic `twilight-echo-plugin`.
4. The [discovery workflow](.github/workflows/community-discovery.yml) scans the latest Release every six hours and updates `community.json` and `plugins.json`. Once the entry appears in [`plugins.json`](plugins.json), users can refresh the Extension Center and search for it. The scheduled run may be delayed.

Automatic entries have the `community` tag and display as **unverified**. The scanner checks the package, URL, manifest, and size; it does not execute plugin code or perform a human review. A plugin ID stays bound to its first discovered repository, so publish updates from the same repository with an increased version. Replacing a package without changing its version is rejected. Invalid or missing releases are omitted until fixed.

## Enable automatic discovery (directory maintainers)

In this repository's **Settings → Actions → General**, enable Actions and set **Workflow permissions** to **Read and write permissions**. The `Discover community plugins` workflow runs on `main` every six hours and can also be started from the **Actions** tab with **Run workflow**. It uses the repository's built-in `GITHUB_TOKEN`; no separate secret is needed. The workflow commits changed `community.json` and `plugins.json` directly to `main`, so branch rules must permit that push. Check the workflow run and the generated index after enabling it.

## Request a reviewed listing

If you want a human-reviewed listing, submit a pull request with `catalog/<plugin-id>.json` and the regenerated `plugins.json`. Follow [catalog/README.md](catalog/README.md). The pull request workflow checks the package and index; maintainers review its README, permissions, and basic behavior. Reviewed catalog entries take precedence over automatic entries with the same ID. Review alone does not grant the “officially verified” badge, which requires a valid publisher signature.

## Update an existing plugin

Increase `plugin.json.version`, rebuild the `.tep`, and publish a new Release in the same repository with the matching tag and filename. The next discovery run replaces the previous community entry. For a reviewed listing, also update `catalog/<plugin-id>.json` and `plugins.json` in a new pull request. Do not edit `community.json` by hand.

## Repository Layout

```text
plugins/
  bilibili-provider/
    plugin.json
    index.mjs
    index.test.mjs
    README.md
  ytmusic-provider/
    plugin.json
    index.mjs
    index.test.mjs
    README.md
  qqmusic-provider/
    plugin.json
    index.mjs
    index.test.mjs
    README.md
    THIRD_PARTY_NOTICES.md
  qishui-provider/
    plugin.json
    index.mjs
    qishui-auth-v6.cjs
    qishui-auth-v6/
  kugou-provider/
    plugin.json
    index.mjs
    index.test.mjs
    README.md
    THIRD_PARTY_NOTICES.md
packages/
  com.twilightecho.provider.bilibili-0.1.13.tep
  com.twilightecho.provider.qqmusic-0.3.2.tep
  com.twilightecho.provider.kugou-0.2.3.tep
  com.twilightecho.provider.ytmusic-1.0.5.tep
catalog/                   # reviewed independent plugins, one JSON file per plugin
community.json             # automatically discovered plugins and ID ownership history
plugins.json
```

- `plugins/<name>/` contains plugin source code.
- `packages/` contains installable `.tep` packages.
- `catalog/` contains reviewed listings for independent repositories.
- `community.json` is maintained by the discovery workflow.
- `plugins.json` is the schemaVersion 1 plugin index consumed by Twilight Echo.

## Current Plugins

### Dynamic Island

Plugin id: `com.bad0rang3.dynamic-island`

Adds a configurable, audio-reactive player overlay at the top of the screen. It
supports live DIY controls for colors, geometry, visible components, animation
speed, expansion behavior and visibility. Requires Twilight Echo `1.2.3` or
higher with the host overlay API; on builds without that API it still installs,
shows an "overlay unavailable, the island will not display" notice (a host
toast when `twilight.ui.notify` is available, plus the settings entry and log)
and never fails to activate. See `plugins/dynamic-island/README.md` for details.

### Bilibili Favorites Provider

Plugin id: `com.twilightecho.provider.bilibili`

Provider id: `bili`

This plugin lets a signed-in user search and browse Bilibili video favorite
folders and play video audio in Twilight Echo. It uses Bilibili Web QR login,
stores cookies only in the plugin private settings file, maps tracks as
`bili:<bvid>:<cid>`, and returns local `127.0.0.1` loopback proxy URLs for
audio playback. Bilibili cover images and avatars are also proxied locally so
the plugin can send the Referer and User-Agent headers required by Bilibili's
image CDN.

Features:

- Web QR login
- Search Bilibili videos from the Twilight Echo streaming page
- Browse video favorite folders
- Expand multi-page videos into one track per page
- Pin one or more favorite folders to the top of the library
- Silent cookie refresh using the login `refresh_token` (no re-scan on rotation)
- 10-minute TTL on favorite-track cache so new favorites show up promptly
- Audio-only playback through a local `127.0.0.1` proxy

### YouTube Music Provider

Plugin id: `com.twilightecho.provider.ytmusic`

Provider id: `ytm`

Search and play YouTube Music tracks, with lyrics, playlists and the user
media library. See `plugins/ytmusic-provider/README.md` for details.

### QQ Music Provider

Plugin id: `com.twilightecho.provider.qqmusic`

Provider id: `qq`

Search and play QQ Music tracks with homepage recommendations, discovery
playlists, lyrics, QR login, user playlists and a local Range-capable stream
proxy. Public catalogue requests follow Rain120/qq-music-api. The plugin
requires an explicit disclaimer acknowledgement before it makes upstream requests. See
`plugins/qqmusic-provider/README.md` for details.

### KuGou Music Provider

Plugin id: `com.twilightecho.provider.kugou`

Provider id: `kugou`

Search public KuGou Music tracks, artists and playlists, resolve KRC lyrics,
scan a user library after QR login and relay audio through a local Range-capable
stream proxy. It embeds a loopback-only KuGouMusicApi-compatible service and
also accepts an explicitly configured user-run loopback service, never a public
API host or third-party proxy. The plugin requires an explicit disclaimer
acknowledgement before it makes requests. See
`plugins/kugou-provider/README.md` for setup and limitations.

### Miku Navigation Theme (Local Preview)

Plugin id: `com.twilightecho.theme.miku-navigation`

A declarative theme that replaces 30 main, settings, and streaming navigation
icons with user-supplied Hatsune Miku artwork. Source and installation instructions are in
[`plugins/miku-navigation/README.md`](plugins/miku-navigation/README.md).
Preview packages are kept under `packages/local-preview/` and are not included
in the marketplace index.

## Build And Test

The pack script reuses the Twilight Echo app repository tooling. By default it
expects the app repository at `D:\Twilight_Echo-main`. Override that path with
`TWILIGHT_ECHO_ROOT` when needed.

```powershell
$env:TWILIGHT_ECHO_ROOT="D:\Twilight_Echo-main"
pnpm test
pnpm run pack
```

To package the QQ Music provider specifically:

```powershell
$env:TWILIGHT_ECHO_ROOT="D:\Twilight_Echo-Pxasen"
node scripts/pack-plugin.cjs qqmusic-provider
node scripts/generate-index.mjs
```

To package the KuGou Music provider specifically:

```powershell
$env:TWILIGHT_ECHO_ROOT="D:\Twilight_Echo-Pxasen"
pnpm run pack:kugou
```

To package the Qishui Music provider specifically:

```powershell
$env:TWILIGHT_ECHO_ROOT="D:\Twilight_Echo-Pxasen"
pnpm run pack:qishui
```

`pnpm run pack` creates or updates:

- `packages/com.twilightecho.provider.bilibili-0.1.13.tep`
- `plugins.json`

`pnpm run pack:qqmusic` creates or updates
`packages/com.twilightecho.provider.qqmusic-0.3.2.tep` and then refreshes
`plugins.json`.

`pnpm run pack:kugou` creates or updates
`packages/com.twilightecho.provider.kugou-0.2.3.tep` and then refreshes
`plugins.json`.

The generated package intentionally includes only runtime files such as
`plugin.json` and `index.mjs`; tests and development files are excluded. If a
plugin contains `THIRD_PARTY_NOTICES.md`, the packer includes that supplemental
license/attribution file alongside the runtime files.

## Use From GitHub

After pushing this repository, use the raw `plugins.json` URL:

```powershell
$env:TWILIGHT_PLUGIN_INDEX_URL="https://raw.githubusercontent.com/Px-asen/Twilight-Echo-plugins/main/plugins.json"
pnpm run dev
```

The index uses relative package URLs such as
`packages/com.twilightecho.provider.bilibili-0.1.13.tep`, so Twilight Echo
resolves the package from the same GitHub raw base URL.

## Use From Your Own Server

You can host the same files on any HTTPS server:

```text
https://plugins.example.com/twilight/plugins.json
https://plugins.example.com/twilight/packages/com.twilightecho.provider.bilibili-0.1.13.tep
https://plugins.example.com/twilight/packages/com.twilightecho.provider.qqmusic-0.3.2.tep
https://plugins.example.com/twilight/packages/com.twilightecho.provider.kugou-0.2.3.tep
```

Then point Twilight Echo at your server:

```powershell
$env:TWILIGHT_PLUGIN_INDEX_URL="https://plugins.example.com/twilight/plugins.json"
pnpm run dev
```

If your package files live under another base URL, regenerate the index:

```powershell
$env:PLUGIN_BASE_URL="https://cdn.example.com/twilight/packages"
pnpm run pack
```

Twilight Echo validates the `.tep` SHA-256 from `plugins.json` before
installing. Regenerate and commit `plugins.json` every time a package changes.

Pure theme plugins declare `contributes.themes` without `main` or `binary`.
The packer includes declared theme stylesheets and the plugin icon. Build the theme
before packaging, then run `pnpm run index` and `pnpm run validate:index` before
publishing the package and index together.
Index metadata such as `homepage` and `repository` must match the packaged manifest
exactly, including omitted fields. Set these in the plugin source and rebuild the
package; the index generator does not add defaults or allow differing overrides.

## License

Apache-2.0. See [LICENSE](LICENSE).

### Jellyfin 音源

`com.twilightecho.provider.jellyfin`：通过服务器地址、用户名和密码登录，支持音乐搜索、全部音乐、歌单、封面和音频播放。需使用包含服务器登录表单的宿主构建，参见 [插件说明](plugins/jellyfin-provider/README.md)。
