# Jellyfin 音源

安装生成的 `.tep` 后，在账号页面选择 Jellyfin，输入服务器完整地址（支持 `/jellyfin` 等子路径）、用户名和密码。需要包含本次服务器登录表单更新的 Twilight Echo 构建；仅版本号为 1.2.2 的旧构建尚不包含该能力。

支持分页搜索、最新音乐、全部音乐、服务器歌列表、收藏和音频播放。全部音乐、收藏、歌列表 summary 各自 trackCount;列表数据 plugin 10-minute TTL cache，再 entry 复用 cache。Logout/server-switch 立即 invalidate;host manual refresh 传 `force=true` 直 fetch。Server/account access permissions由 Jellyfin 决定。Password 只用于 login request;plugin private settings 保存 server address、user ID,session token,logout 清除 that info。Switch server后,old-server tracks 不会 mis-play on the new server。

插件声明 `network`、`settings` 和 `library:read` 权限；注册 `library` Provider 能力时，宿主要求显式声明 `library:read`。0.1.1 补齐该声明，修复 0.1.0 在安装或启用时提示「未声明 library:read 权限」的问题。安装修复版请刷新插件市场并更新至 0.1.1，或从本地安装新版 `.tep`。

网络请求使用服务器原有 HTTP(S) 配置，不跳过证书校验；带凭据的 API 请求不自动跟随重定向。音频与封面地址通过宿主媒体授权路径使用。

接口依据 Jellyfin 官方 API：

- https://kotlin-sdk.jellyfin.org/guide/authentication.html
- https://typescript-sdk.jellyfin.org/classes/generated-client.AudioApi.html

验证:`node --test plugins/jellyfin-provider/index.test.mjs`。用例覆盖登录、重启恢复、失败登录、分页、 favourite/playback 地址、 favourite 列表与取消操作。已联调 against Jellyfin 12.1 (本地 192.168.1.30 与公网 ofchar 服务器) :`/Items` + Authorization header 与 `IsFavorite=true` 服务端 favourite 过滤、封面地址、 universal 直链 (带源文件 `Container` )与 mp3转码兜链 均 200 返回真实 audio 数据。
0.1.2 收藏：宿主 `likeTrack`/`isTrackLiked` 映射到服务端 `Users/{uid}/FavoriteItems/{id}`（POST/DELETE）与 `Items?Ids=&IsFavorite=true` 读过滤；宿主 `resolveProviderTrackId` 会剥掉 `jellyfin:` 前缀，故 `itemIdOf()` 同时接受 `jellyfin:<enc serverUrl>:<itemId>` 与 `<enc serverUrl>:<itemId>`，否则每次收藏都抛「另一台服务器」，连续 3 次会触发宿主 RPC 熔断（`circuit is open; retry after …ms`）并连带阻断播放。实机验证：收藏 26 条，toggle 往返正确。
0.1.2 性能：`allPages` 由顺序翻页改为「首页取 TotalRecordCount + 8 并发按序合并」，页大小 250；`Fields` 去掉无人使用的 `PrimaryImageAspectRatio`。3569 首库实测 14.4s → 6.3s，条目元数据（采样率/位深/声道/码率/容器/文件大小）不变。

构建：`node scripts/pack-plugin.cjs jellyfin-provider --twilight-root D:/Twilight_Echo-Pxasen`，再运行 `pnpm run index` 与 `pnpm run validate:index`。发布时将 `packages/com.twilightecho.provider.jellyfin-0.1.1.tep` 和更新后的 `plugins.json` 一起提交，保留已发布的旧版本包。插件源码不放入播放器主仓库。
