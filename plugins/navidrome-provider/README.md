# Navidrome 音源

插件 ID：`com.twilightecho.provider.navidrome`；Provider ID：`navidrome`。

使用 Subsonic / OpenSubsonic API 连接自己的 Navidrome 音乐服务器。插件在本仓库独立维护和分发，需要 Twilight Echo 1.3.0 或更新版本提供服务器登录表单及 Provider API。

## 安装与连接

1. 在 Twilight Echo 的扩展中心安装 Navidrome 音源，或从本地安装 `packages/com.twilightecho.provider.navidrome-1.0.0.tep`。
2. 启用插件，在流媒体页的音源登录入口选择 Navidrome。
3. 输入服务器地址、用户名和密码，登录后搜索音乐或打开服务器歌单。

服务器地址支持 HTTP(S) 和反向代理子路径，例如 `https://music.example.com`、`https://music.example.com/navidrome`。末尾的 `/rest/` 会自动移除。

## 功能

- 歌曲、专辑搜索，以及服务器歌单的名称筛选和分页。
- 用户可访问的歌单、歌单曲目分页和专辑曲目读取。
- 音频播放和封面读取。
- 同步歌词转换为 LRC，保留时间戳和歌词偏移；支持纯文本歌词和旧版歌词接口回退。
- 登录状态恢复、退出清理和网络请求取消。

Subsonic `search3` 不返回结果总数，插件多读取一条结果判断是否还有下一页，显示的页数会随翻页更新。歌单分页在服务器返回的完整曲目列表上进行。歌单写入、下载、收藏管理和推荐功能尚未实现。

## 权限与凭据

插件声明 `network`、`settings` 和 `library:read` 权限。服务器地址和用户名保存在插件私有设置中；密码使用宿主加密的敏感设置存储，以便每次请求生成 Subsonic `t = MD5(password + salt)` 认证参数。失败登录不会覆盖原有连接配置，退出登录会清除全部连接配置。

播放和封面地址由宿主转换为媒体授权地址后交给界面。网络请求使用服务器的 HTTP(S) 配置和正常证书校验。

## 开发与打包

在本仓库根目录运行：

```powershell
node scripts/pack-plugin.cjs navidrome-provider --twilight-root D:/Project/Twilight_Echo
pnpm run index
pnpm run validate:index
node --test plugins/navidrome-provider/index.test.mjs
```

也可将 `TWILIGHT_ECHO_ROOT` 设置为播放器主仓库路径后运行 `pnpm run pack:navidrome`。打包脚本只包含运行所需的 `plugin.json` 和 `index.mjs`。

测试覆盖登录和凭据清理、失败登录、token/salt 认证、搜索分页、反向代理子路径、歌单与专辑曲目、同步歌词、歌词回退、取消请求，以及安装包、源码 manifest、市场索引和 SHA-256 的一致性。实际 Navidrome 服务器的音频播放仍需实例联调。

发布时一并提交源码、`packages/com.twilightecho.provider.navidrome-1.0.0.tep` 和更新后的 `plugins.json`。已发布版本的安装包保留，后续变更增加版本号后重新打包。

接口参考：[Subsonic API](https://www.subsonic.org/pages/api.jsp)、[OpenSubsonic 歌词接口](https://opensubsonic.netlify.app/docs/endpoints/getlyricsbysongid/)。
