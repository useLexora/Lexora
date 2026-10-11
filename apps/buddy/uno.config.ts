import { defineConfig, presetWind3, transformerVariantGroup } from 'unocss'
import { createUnoTheme } from './shared/theme/themeTokens'

const sharedTheme = createUnoTheme('buddy')
const controlHeights = {
  'region-header': 'var(--buddy-region-header-height)',
  'menu-row': 'var(--buddy-menu-row-height)',
  'control': 'var(--buddy-composer-control-height)',
}

export default defineConfig({
  presets: [presetWind3()],
  transformers: [transformerVariantGroup()],
  theme: {
    ...sharedTheme,
    fontFamily: { ...sharedTheme.fontFamily, brand: 'var(--buddy-font-brand)' },
    borderRadius: {
      ...sharedTheme.borderRadius,
      'icon': 'var(--buddy-icon-button-radius)',
      'menu': 'var(--buddy-menu-radius)',
      'menu-item': 'var(--buddy-menu-item-radius)',
      'control': 'var(--buddy-composer-control-radius)',
    },
    width: {
      'app-sidebar': 'var(--buddy-app-sidebar-width)',
      'workspace-sidebar': 'var(--buddy-workspace-sidebar-width)',
      'control': 'var(--buddy-composer-control-height)',
    },
    height: controlHeights,
    minHeight: controlHeights,
    spacing: { 'menu-gap': 'var(--buddy-menu-row-gap)' },
    fontSize: {
      'sidebar-header': ['var(--buddy-sidebar-header-font-size)', {}],
      'sidebar-section': ['var(--buddy-sidebar-section-font-size)', {}],
      'sidebar-item': ['var(--buddy-sidebar-item-font-size)', {}],
      'sidebar-account': ['var(--buddy-sidebar-account-font-size)', {}],
    },
    boxShadow: Object.fromEntries(['soft', 'raised', 'overlay', 'window', 'illustration'].map(name => [name, `var(--buddy-shadow-${name})`])),
  },
  shortcuts: {
    'transition-state-colors': 'transition-[background-color,color] duration-[var(--buddy-motion-state-duration)] ease-[var(--buddy-motion-state-easing)]',
    'ui-focus-ring': 'focus-visible:(outline-solid outline-2 outline-focus outline-offset-[-2px])',
    'ui-menu-state': 'enabled:hover:not-active:(bg-hover text-hover-fg) enabled:active:(bg-pressed text-pressed-fg) focus-visible:(bg-hover text-hover-fg outline-0) aria-checked:(bg-selected text-selected-fg) aria-checked:enabled:hover:not-active:bg-selected-hover aria-checked:enabled:active:bg-pressed aria-checked:focus-visible:bg-selected-hover aria-pressed:(bg-selected text-selected-fg) aria-pressed:enabled:hover:not-active:bg-selected-hover aria-pressed:enabled:active:bg-pressed aria-pressed:focus-visible:bg-selected-hover disabled:(cursor-not-allowed opacity-50)',
    'ui-menu-option': 'flex min-w-0 items-center justify-between border-0 rounded-menu-item bg-transparent text-strong cursor-pointer text-left ui-menu-state',
    'ui-menu-item': 'grid min-w-0 min-h-menu-row grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 border-0 rounded-menu-item bg-transparent text-strong cursor-pointer px-2 py-[0.3rem] text-left ui-menu-state',
  },
  content: {
    filesystem: ['src/**/*.{vue,ts,tsx,js,jsx}', '!src/**/__tests__/**'],
    pipeline: { include: [/[\\/]src[\\/].*\.(vue|[jt]sx?)($|\?)/, /[\\/]index\.html$/] },
  },
})
