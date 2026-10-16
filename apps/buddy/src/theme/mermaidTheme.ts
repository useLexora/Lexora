import type { MermaidConfig } from 'mermaid'
import { mixThemeColor } from '@buddy-shared/theme/resolveTheme'
import { computed } from 'vue'
import { desktopThemeSnapshot } from './desktopThemeState'
import { desktopTypography } from './desktopTypography'

export const desktopMermaidTheme = computed<MermaidConfig>(() => {
  const { colors: c, descriptor } = desktopThemeSnapshot.value.active
  const typography = desktopTypography.value
  const solid = (color: string) => color.length === 9
    ? mixThemeColor(c.reading, color, Number.parseInt(color.slice(7), 16) / 255)
    : color

  return {
    theme: 'base',
    look: 'classic',
    fontFamily: typography.body,
    sequence: {
      actorFontSize: Number.parseInt(typography.bodySize),
      messageFontSize: Number.parseInt(typography.bodySize),
      noteFontSize: Number.parseInt(typography.bodySize),
    },
    themeVariables: {
      darkMode: descriptor.appearance === 'dark',
      background: solid(c.subtle),
      fontSize: typography.bodySize,
      primaryColor: solid(c.selected),
      primaryTextColor: c['reading-fg'],
      primaryBorderColor: c.accent,
      secondaryColor: solid(c.subtle),
      secondaryTextColor: c['reading-fg'],
      secondaryBorderColor: solid(c['border-strong']),
      tertiaryColor: solid(c.raised),
      tertiaryTextColor: c['reading-fg'],
      tertiaryBorderColor: solid(c['border-strong']),
      lineColor: c.muted,
      textColor: c['reading-fg'],
      noteBkgColor: solid(c.subtle),
      noteTextColor: c['reading-fg'],
      noteBorderColor: solid(c['border-strong']),
      edgeLabelBackground: solid(c.subtle),
      clusterBkg: solid(c.subtle),
      clusterBorder: solid(c['border-strong']),
      dropShadow: 'none',
      useGradient: false,
    },
  }
})
