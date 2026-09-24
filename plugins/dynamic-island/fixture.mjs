export const DEFAULT_CONFIG = {
  appearance: {
    backgroundColor: '#000000',
    backgroundOpacity: 100,
    textColor: '#ffffff',
    accentColor: '#ff8fb6',
    accentSource: 'custom',
    visualizerColor: '#a89de3',
    fontScale: 100,
    collapsedRadius: 25,
    expandedRadius: 58,
    audioReactive: true
  },
  layout: {
    collapsedWidth: 250,
    collapsedHeight: 48,
    expandedWidth: 430,
    anchor: 'center',
    offsetX: 0,
    offsetY: 12,
    display: 'main-window'
  },
  components: {
    collapsedContent: 'artwork',
    cover: true,
    visualizer: true,
    lyric: true,
    progress: true,
    time: true,
    favorite: true,
    skip: true,
    volume: true
  },
  behavior: {
    expandTrigger: 'hover',
    collapseDelayMs: 420,
    motion: 'normal',
    visibility: 'always'
  }
}
