export function palette(dark) {
  const paper = dark ? '#102429' : '#eaf4f3'
  const card = dark ? '#193137' : '#f8fcfa'
  const ink = dark ? '#e7f4ef' : '#183b3d'
  const muted = dark ? '#a5bfbd' : '#526c6e'
  const accent = dark ? '#63d6c8' : '#087f79'
  const hover = dark ? '#244341' : '#e4f2ed'
  const active = dark ? '#244a49' : '#d7eee8'
  const border = dark ? '#355354' : '#caddd7'
  const tokens = {
    'color.primary.500': accent,
    'color.primary.400': dark ? '#8be5d8' : '#066d68',
    'color.primary.300': dark ? '#b0eee3' : '#398f87',
    'color.primary.rgb': dark ? '99, 214, 200' : '8, 127, 121',
    'color.favorite': dark ? '#e69bb7' : '#a74870',
    'color.accentCyan': dark ? '#78cbd1' : '#137e8c',
    'color.neutral.50': paper,
    'color.neutral.100': card,
    'color.neutral.200': border,
    'color.neutral.300': dark ? '#769b98' : '#718f88',
    'color.neutral.500': muted,
    'color.neutral.700': dark ? '#c5ddd5' : '#355650',
    'color.neutral.900': ink,
    'background.gradientStart': paper,
    'background.gradientEnd': dark ? '#18363a' : '#dcefeb'
  }
  const assign = (value, ids) =>
    ids.split(' ').forEach((id) => {
      tokens[id] = value
    })
  assign(paper, 'surface.app surface.local surface.settings surface.streaming')
  assign(
    card,
    'surface.card surface.player settings.control.surface navigation.surface playback.equalizer.panelSurface playback.equalizer.buttonSurface'
  )
  assign(
    border,
    'surface.cardBorder settings.control.border settings.panel.border navigation.border library.table.border playback.equalizer.panelBorder'
  )
  assign(
    ink,
    'shell.control.text settings.text.primary settings.navigation.text navigation.text navigation.hoverText library.row.text typography.chromeText'
  )
  assign(muted, 'settings.text.muted navigation.icon library.icon')
  assign(
    hover,
    'surface.subtle surface.hover shell.control.hoverSurface settings.navigation.hoverSurface navigation.hoverSurface library.row.hoverSurface library.actionSurface'
  )
  assign(
    active,
    'surface.active settings.navigation.activeSurface navigation.activeSurface library.selection.surface library.selection.hoverSurface'
  )
  assign(
    accent,
    'navigation.activeText navigation.indicator library.selection.indicator playback.accent playback.equalizer.sliderThumb playback.equalizer.guide playback.equalizer.spectrum'
  )
  assign(dark ? 'rgba(16,36,41,0.45)' : 'rgba(248,252,250,0.45)', 'library.table.surface')
  assign(dark ? 'rgba(25,49,55,0.84)' : 'rgba(248,252,250,0.88)', 'material.glass')
  assign(dark ? 'rgba(25,49,55,0.96)' : 'rgba(248,252,250,0.96)', 'material.glassStrong')
  assign(border, 'material.glassBorder')
  assign(
    dark ? 'rgba(99,214,200,0.10)' : 'rgba(8,127,121,0.08)',
    'material.glowMain material.glowSoft material.glowCyan'
  )
  assign(
    dark ? '#466b69' : '#90b6ae',
    'playback.progress.track playback.equalizer.sliderTrack playback.equalizer.grid'
  )
  tokens['navigation.activeText'] = dark ? accent : '#066d68'
  return { tokens }
}
