export function createEditor(icons) {
  const controls = []
  const add = (id, label, group, variable, value, options = {}) => controls.push({
    id, label, group, variable, type: 'text', defaults: { pureWhite: value, dark: value }, ...options
  })
  add('wall-image', '全局背景图片', '全局背景', '--miku-wall-image', 'none', { type: 'image' })
  add('wall-wash', '背景蒙版', '全局背景', '--miku-wall-wash', '33%', { type: 'number', unit: '%', min: 0, max: 100, defaults: { pureWhite: '33%', dark: '43%' } })
  add('wall-position', '背景位置', '全局背景', '--miku-wall-position', 'center 42%')
  add('wall-size', '背景缩放', '全局背景', '--miku-wall-size', 'cover', { type: 'select', options: ['cover', 'contain', '100% auto', 'auto 100%'] })
  add('home-wall-wash', '首页背景蒙版', '全局背景', '--miku-wall-wash', '50%', { selector: 'body:has(.app-shell):has(.home)', type: 'number', unit: '%', min: 0, max: 100 })
  add('settings-wall-wash', '设置背景蒙版', '设置', '--miku-wall-wash', '53%', { selector: 'body:has(.app-shell) .settings-overlay-root--active', type: 'number', unit: '%', min: 0, max: 100 })
  const hero = ':is(.home .feature-card, .streaming-page .home-view .hero)'
  add('hero-image', '首页插画', '首页卡片', '--miku-hero-image', 'none', { type: 'image' })
  for (const [id, label, value, max] of [['size', '插画大小', '72%', 200], ['x', '水平位置', '70%', 100], ['y', '垂直位置', '12%', 100], ['mask', '左侧淡化', '22%', 100]]) {
    add(`hero-${id}`, label, '首页卡片', `--miku-hero-${id}`, value, { selector: hero, type: 'number', unit: '%', min: 0, max })
  }
  add('hero-opacity', '插画透明度', '首页卡片', '--miku-hero-opacity', '0.96', { selector: hero, type: 'number', min: 0, max: 1, step: 0.01 })
  const library = 'body:has(.app-shell) :is(.song-list:has(.track-table-wrapper), .streaming-content:has(.stage-rows, .track-table-wrapper))'
  add('library-image', '歌曲列表插画', '歌曲列表', '--miku-library-image', 'none', { type: 'image' })
  add('library-wash', '列表蒙版', '歌曲列表', '--miku-library-wash', '44%', { selector: library, type: 'number', unit: '%', min: 0, max: 100, defaults: { pureWhite: '44%', dark: '60%' } })
  for (const [id, label, value, min, max] of [['width', '人物宽度', '618.75px', 100, 1600], ['height', '人物高度', '1100px', 100, 2000], ['top', '垂直偏移', '-60px', -600, 600]]) {
    add(`library-${id}`, label, '歌曲列表', `--miku-library-art-${id}`, value, { selector: library, type: 'number', unit: 'px', min, max, step: 0.25 })
  }
  for (const state of ['peek', 'listening', 'thinking', 'done', 'empty']) add(`state-${state}`, state, '状态插画', `--miku-state-${state}`, 'none', { type: 'image' })
  for (const [index, icon] of icons.entries()) add(`icon-${index}`, icon.label ?? icon.file, icon.group === 'settings' ? '设置图标' : icon.group === 'streaming' ? '流媒体图标' : '导航图标', `--miku-icon-${index}`, 'none', { type: 'image' })
  for (const item of controls) {
    if (item.group === '首页卡片') item.targets = { local: '.home .feature-card', streaming: '.streaming-page .home-view .hero' }
    if (item.group === '歌曲列表') item.targets = { local: 'body:has(.app-shell) .song-list:has(.track-table-wrapper)', streaming: 'body:has(.app-shell) .streaming-content:has(.stage-rows, .track-table-wrapper)' }
  }
  return { schemaVersion: 1, controls }
}
