import { defineConfig, presetUno } from 'unocss'

const alphaLevels = [10, 20, 30, 40, 50, 60, 70, 80] as const

const semanticColorTokens = {
  'primary': '--brand-primary',
  'success': '--brand-success',
  'warning': '--brand-warning',
  'danger': '--brand-error',
  'error': '--brand-error',
  'info': '--brand-info',
  'main': '--brand-text-primary',
  'regular': '--brand-text-regular',
  'secondary': '--brand-text-secondary',
  'placeholder': '--brand-text-placeholder',
  'disabled': '--brand-text-disabled',
  'border': '--brand-border-base',
  'border-light': '--brand-border-light',
  'fill': '--brand-fill-base',
  'fill-light': '--brand-fill-light',
  'fill-lighter': '--brand-fill-lighter',
  'body': '--brand-bg-body',
  'sidebar': '--brand-bg-sidebar',
  'surface': '--brand-bg-surface',
  'surface-raised': '--brand-bg-surface-raised',
} as const

const themeColors = {
  ...Object.fromEntries(
    Object.entries(semanticColorTokens).map(([name, token]) => [name, `var(${token})`]),
  ),
  ...Object.fromEntries(
    Object.entries(semanticColorTokens).flatMap(([name, token]) =>
      alphaLevels.map(level => [
        `${name}-a${level}`,
        `color-mix(in srgb, var(${token}) ${level}%, transparent)`,
      ]),
    ),
  ),
}

export default defineConfig({
  presets: [presetUno()],
  theme: {
    colors: themeColors,

    fontFamily: {
      sans: 'Inter, system-ui, -apple-system, sans-serif',
    },
  },
})
