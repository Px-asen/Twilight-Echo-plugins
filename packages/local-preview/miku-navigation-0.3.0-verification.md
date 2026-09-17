# Miku 导航 0.3.0 验证记录

日期：2026-09-15。

## 本次交付

- 插件源码：`../../plugins/miku-navigation/`。
- 安装包：`com.twilightecho.theme.miku-navigation-0.3.0.tep`，2084651 字节。
- SHA-256：`5ff28530fb6546d6d51de9e373e73a0b2f85020f67dbb04f24c823822d910adf`。
- 继续使用原插件 ID 和主题 ID，可替换 0.2.0。
- 原图完整保存，构建时内嵌到 CSS；运行时没有脚本、网络请求或新增权限。

## 通过

- `node build.mjs` 构建 30 个图标与首页插画。
- 修改的源文件通过宿主 Prettier 格式化。
- 提取宿主 LocalDashboard.vue 的实际卡片模板和 LocalDashboard.css，使用 Vue、
  宿主主题令牌与模拟歌曲，在无头 Edge 中验证 12 组组合：深浅色 ×
  1440 / 1000 / 800px × 液态玻璃开关。
- 图像解码为 1969×1599；背景蒙版与插画层不拦截鼠标。
- 主题开启前后卡片内部、文字区、专辑封面和操作按钮几何位置一致。
- 专辑封面保持可见；播放与随机按钮能触发模拟处理函数。
- 移除主题恢复原有背景图片可见性。
- 检查深浅色及窄屏截图，补齐插画右边缘渐隐。
- 宿主打包工具成功生成 36 文件安装包；ZIP 校验通过，全部文件与源码字节一致，
  30 个图标齐全，首页 JPEG 与用户提供的原始图片字节一致。

## 主仓库既有回归失败

本次未修改宿主源代码。

- `pnpm run test:themes`：255 通过，1 失败；失败项为
  `renderer business styles do not exceed the hard-coded color baseline`。
- `pnpm run test:plugins`：389 通过，1 失败，1 跳过；失败项为
  `data IPC applies path and storage limits before touching local files`，
  断言仍匹配旧版歌词读取实现。

这两项在 0.2.0 验证记录中也已报告。详细日志在外部插件仓库
`.cache/miku-navigation-preview/test-themes-v0.3.0.log` 和
`test-plugins-v0.3.0.log`。

截图使用宿主图标作为模拟专辑封面。验证没有安装到正在运行的完整客户端，
没有调用真实音频播放；应通过扩展中心导入安装包，再在主题工作室应用 Miku 导航。
