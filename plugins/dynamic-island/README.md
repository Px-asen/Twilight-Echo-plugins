# 灵动岛

插件 ID：`com.bad0rang3.dynamic-island`

在屏幕顶部显示由 Twilight Echo 宿主渲染的灵动岛播放器。插件只负责保存
配置和注册入口，窗口、播放状态、音频频谱与交互均由宿主提供。

## 功能

- 收起时显示封面、歌曲信息、当前歌词或实时频谱
- 展开后提供进度、播放、上一首、下一首、收藏和音量控制
- 根据封面主色生成氛围光，支持音频响应和加载扫光
- DIY 调整颜色、透明度、字体、尺寸、圆角、位置与显示屏
- DIY 控制组件、展开方式、收起延迟、动画速度与自动隐藏策略

## 兼容性

需要 Twilight Echo `1.3.0` 或更高版本，并依赖宿主的 Overlay API。对应宿主
实现见 [`Twilight_Echo` #91](https://github.com/Px-asen/Twilight_Echo/pull/91)。

## 使用

安装后可通过播放器栏的「灵动岛」按钮显示或隐藏。DIY 入口位于：

`设置 → 常规 → 插件设置 → 灵动岛 DIY`

设置会实时应用，并保存在插件私有设置中。

## 构建与测试

在本仓库根目录运行：

```powershell
$env:TWILIGHT_ECHO_ROOT="C:\path\to\Twilight_Echo"
node --test plugins/dynamic-island/*.test.mjs
pnpm run pack:dynamic-island
pnpm run validate:index
```
