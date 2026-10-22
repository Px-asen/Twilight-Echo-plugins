# 莱茵 0.2.10：帧率与渲染开销

设置 → 画面与声音 → 画质提供 24、30、60、120 FPS，默认 60 FPS。默认原始画质的像素密度上限由 1.5× 改为 1.0×。帧率立即生效、自动保存，切换画质预设保留帧率。旧的显式画质选择继续保留。实际帧率也受显示器刷新率和机器负载限制。

## 技术栈

- 插件：TypeScript 5.9.3、Vite 7.3.6（锁文件实装版本），原生 DOM/CSS 和 Web Animations。
- 图形：Three.js 0.183.2 的 WebGLRenderer / WebGL2；Windows 由 Chromium 的 ANGLE 使用本机图形驱动。
- 场景：GLTFLoader 加载 GLB 模型，InstancedMesh 复用专辑几何与变换，封面图集、MeshPhysicalMaterial 透射材质和自定义 GLSL 光带。
- 后处理：EffectComposer、RenderPass、SSAOPass、景深（复用深度的 MusicBokehPass）、可选 SMAA、OutputPass。
- 宿主：Twilight Echo 的 Electron 43.5.0 / Vue 3.5 / Pinia 3，完整界面通过 sandbox iframe 和 MessageChannel bridge v2 读取曲库、控制宿主音频播放。

## 修改

1. 在实际场景更新前进行时间戳限帧，主场景、360° 查看器和档案参考入口共用配置。动画仍使用真实时间；隐藏、恢复和切换帧率时重置期限，长卡顿后不补绘积压帧。
2. 实例矩阵按 GPU 的 Float32 精度比较，只有实际变化才写入缓冲并请求上传。
3. 音乐场景阴影缓存跟踪投影物的世界变换、实例缓冲版本、可见性、材质和光源目标。变化时立即刷新；静止场景和后处理通道复用已生成的阴影。画质变化仍强制刷新。

## 验证

`npm test` 包含默认值、旧配置、保存恢复、60/120/144/165/240 Hz 下四档帧率、长卡顿/恢复、Float32 矩阵和阴影失效行为。

启动 `npm run dev:host` 后运行 `npm run check:performance`，检查渲染循环的实际 FPS、设置选项和重载保存，并比较缓存阴影与强制重绘的 GPU 像素。浏览器测试需安装 Playwright，可通过 `PLAYWRIGHT_MODULE` 指定已有模块，`RHINE_TEST_URL` 指定测试服务地址。

本机 Edge 无界面测试（1440×900、设备像素比 1.5）实测四档分别为 24、30、60、119 FPS；默认画质像素上限为 1.0×。相同静止场景的缓存帧为 26 次绘制，强制刷新阴影为 28 次，RGBA 最大差异为 1/255，处于 8 位舍入误差范围，WebGL 错误数为 0。`npm test` 共 14 项通过，画质兼容性和帧计时检查通过。以上是渲染行为验证，实际宿主 GPU 占用降幅需在相同窗口和场景下另行测量。

旧的 `check-music-settings-panel.mjs` 使用的 DOM 替身缺少歌词容器，在未修改的 0.2.9 源码上同样因 `#music-lyrics` 断言失败；本次设置交互由实际浏览器测试覆盖。
