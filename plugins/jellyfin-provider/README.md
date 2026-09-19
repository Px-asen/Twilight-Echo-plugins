# Jellyfin 音源

安装生成的 `.tep` 后，在账号页面选择 Jellyfin，输入服务器完整地址（支持 `/jellyfin` 等子路径）、用户名和密码。需要包含本次服务器登录表单更新的 Twilight Echo 构建；仅版本号为 1.2.2 的旧构建尚不包含该能力。

支持分页搜索、最新音乐、全部音乐、服务器歌单、封面和音频播放。服务器和账号访问权限由 Jellyfin 决定。密码只用于登录请求；插件私有设置保存服务器地址、用户 ID 和会话令牌，退出登录清除这些信息。切换服务器后，旧服务器曲目不会被误发到新服务器。

网络请求使用服务器原有 HTTP(S) 配置，不跳过证书校验；带凭据的 API 请求不自动跟随重定向。音频与封面地址通过宿主媒体授权路径使用。

接口依据 Jellyfin 官方 API：
- https://kotlin-sdk.jellyfin.org/guide/authentication.html
- https://typescript-sdk.jellyfin.org/classes/generated-client.AudioApi.html

验证：`node --test plugins/jellyfin-provider/index.test.mjs`。用例覆盖登录、重启恢复、失败登录、分页、播放地址和取消操作。尚无报告者的 Jellyfin 12 实例，具体版本兼容性与真实音频播放待服务器联调确认。

构建：`node scripts/pack-plugin.cjs jellyfin-provider --twilight-root D:/Twilight_Echo-Pxasen`。插件源码不放入播放器主仓库。
