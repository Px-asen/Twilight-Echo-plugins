# 莱茵生命 · 音乐档案馆

Twilight Echo 的完整界面插件预览版 0.2.9，基于 RonaldDeng/Rhine-Music-Demo V0.5.0（a889801f）。
0.2.9 将主界面左上标题改为 `TwilightEcho`，保留原副标题、字号、布局及动效。
保留主项目三维 CD 盒、晨雾/月影、音乐架入场、标题字轮及详情编排。
加载画面改为 RhineLabUI 原版开场（约 22 秒），保留轨迹、节奏与转场，只将文案换为 Twilight Echo 和音乐库内容；资源准备与开场并行。

播放区点击“歌词”图标，或从“工作台 → 歌词”进入音频档案阅读页：左侧三维 CD、右侧同步歌词，竖屏自动改为上下布局。原文与译文分层，支持 LRC、增强 LRC、YRC、TTML、逐字点亮和纯文本。点击定时歌词或拖动进度可跳转；手动滚动后可点“回到当前”，停止操作 5 秒后自动恢复跟随。关闭或 Esc 返回原先的专辑、页签、滚动和总览，宿主继续播放。点击歌名仍只定位歌曲。歌词页使用既有 bridge v2，不要求为 0.2.8 升级宿主。

在“设置 → 画面与声音 → 外观”开启“使用默认封面”，全部专辑统一使用当前主题的同一张图片：晨雾使用日光沙丘，月影使用月夜海面。抽出专辑查看时渐显真实封面，回位时恢复默认封面；缺少原图时使用文字封面。切换主题时封面同步更换，设置自动保存。关闭可恢复专辑原图。

0.2.4 继续复用回位专辑的材质与封面、逐帧槽位坐标和相邻波形采样，减少连续导航的分配与重复计算，保持原画质和动画；实测与验证见 docs/PERFORMANCE_0.2.4.md。此前的深度绘制、图集上传和悬停拾取优化见 docs/PERFORMANCE_0.2.3.md。

需要本次兼容宿主构建，包含 experience bridge v2 及电台、播客、网络源、统计等服务能力；仅版本字符串相同的旧宿主不保证兼容。
在插件管理中安装生成的 `.tep` 并启用，可从“完整界面”选择作为启动界面。
插件安装不会自动改变启动设置。退出界面不停止宿主播放。

音乐架右上角“工作台”提供曲库、队列、收藏歌单、声音与设备、DSP、在线音源、下载、插件、电台、播客、网络音乐源、聆听统计、诊断、主题工具及应用设置。
托盘播放器、迷你播放器和桌面歌词入口位于“应用设置”。主题工坊需先启用其宿主插件。

开发：`npm ci`，`npm run dev:host`；`?demo=1` 使用原版三张演示封面。
构建：`npm run build`。宿主模式只通过 MessageChannel 使用真实曲库与音频引擎。
独立浏览器模式保留上游预览行为。

## 维护与反馈

- 维护者：Px-asen（Twilight Echo）；上游 Rhine Music 由 RonaldDeng 维护。
- 反馈入口：[Twilight-Echo-plugins Issues](https://github.com/Px-asen/Twilight-Echo-plugins/issues)。
- 运行平台：随 Twilight Echo 宿主运行，当前在 Windows 10/11 验证；macOS 与 Linux 宿主尚未验证。
- 上游与版本：基于 [RonaldDeng/Rhine-Music-Demo](https://github.com/RonaldDeng/Rhine-Music-Demo) V0.5.0（`a889801f`），加载开场另参考 [LBEILC/RhineLabUI](https://github.com/LBEILC/RhineLabUI)（`12cc5e40`）。插件使用独立版本号（当前 0.2.9），由本仓库维护；上游作者未参与本插件的开发，也不为其提供支持或背书。

源码及资源来源见 UPSTREAM.json、UPSTREAM_README.md、NOTICE.md 和 LICENSE。
歌词实现、许可与实测记录见 docs/LYRICS-0.2.8.md；`npm run check:lyrics` 运行解析／时钟及隔离宿主界面测试（沿用项目浏览器测试环境）。
已验证范围与高级功能限制见 IMPLEMENTATION_STATUS.md。补充项目评估见 docs/SUPPLEMENTARY_ASSESSMENT.md。
