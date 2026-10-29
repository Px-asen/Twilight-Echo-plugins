# 0.2.0 验证记录

验证日期：2026-10-24。候选包：`packages/com.twilightecho.assistant.echo-0.2.0.tep`。

## 已通过

- `npm run test:echo-assistant`：64 项通过。覆盖三种流式协议的结束事件、连接保持打开、CRLF／跨块解析、流内错误、空闲超时与取消；心跳或空 JSON 不会延长超时。
- 停止与状态回归：快速完成先于发送响应、部分文字保留、停止确认不写入、重复停止、旧运行事件隔离、关闭重开恢复运行与确认卡。
- 工作流与存储回归：无 API 全库分页检查（4101 首）、空库、取消后的部分结果、重复组截断总数、报告重载与过期、角色快照和旧数据兼容、并发用量记账。
- `npm run build:echo-assistant`：TypeScript 检查和 Vite production 构建通过。
- `npm run test:echo-assistant:ui`：Playwright + Chrome 通过，页面错误为 0。使用 production UI、真实 gateway、模拟宿主 MessagePort 和独立的 421 首测试曲库；模型仅为本地 SSE 服务，共 6 次请求。

浏览器验收包含实际点击停止、确认／拒绝、草稿与中文输入法、滚动与回到最新、关闭重开、角色和快捷指令、报告、340px 窄屏，以及系统／宿主减少动态效果。外观检查覆盖宿主显式明暗模式、系统模式、明暗独立强调色、预置与自定义主题色；切换时控件前景与底色同步更新。

本轮浏览器证据：仓库 `.cache/echo-assistant-ui-1792784627863/result.json`，同目录保存 `01-welcome.png` 至 `09-settings-light.png`。已人工查看深浅欢迎页、报告、确认卡、重复曲目、窄屏和设置的真实渲染。

## Electron 宿主集成验收未完成

`npm run test:echo-assistant:electron` 在 Electron 主进程创建独立测试日志目录时被 Windows 拒绝：

```text
EPERM: operation not permitted, mkdir
D:\Project\Twilight-Echo-plugins\.cache\echo-assistant-smoke-1792782991805\logs
```

因此尚未验证真实宿主中的 `.tep` 安装和面板桥接。浏览器结果使用模拟宿主，不能替代这项验收。保留了 `test/smoke.mjs` 和 `test/smoke-bootstrap.cjs`；后续宿主集成验收需在允许 Electron 写入该隔离测试目录的环境中运行同一命令。未修改系统安全策略，也未安装到真实用户资料目录。

交付包不自动安装、不更新市场索引、不远端发布；0.1.0 包保留。
