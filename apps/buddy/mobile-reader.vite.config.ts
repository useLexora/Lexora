import { fileURLToPath } from 'node:url'
import vue from '@vitejs/plugin-vue'
import UnoCSS from 'unocss/vite'
import { defineConfig } from 'vite'
import classicDark from './extensions/bundled/lexora.themes/themes/classic-dark.json'
import classicLight from './extensions/bundled/lexora.themes/themes/classic-light.json'
import { resolveTheme } from './shared/theme/resolveTheme'
import { themeDocumentSchema } from './shared/theme/themeDocument'
import { themeFonts } from './shared/theme/themeTokens'
import { markdownThemeVariables } from './src/theme/markdownTheme'
import unoConfig from './uno.config'

const appearance = {
  typography: { bodySize: 15, bodyLineHeight: 24 },
  ...Object.fromEntries((['light', 'dark'] as const).map((mode) => {
    const theme = resolveTheme({ id: `mobile-${mode}`, label: 'Lexora', appearance: mode, source: 'fallback', extensionId: null, packageName: '', swatch: '' }, themeDocumentSchema.parse(mode === 'dark' ? classicDark : classicLight))
    return [mode, {
      colors: theme.colors,
      variables: { ...theme.variables, ...markdownThemeVariables(theme.colors), '--buddy-font-ui': themeFonts.ui, '--buddy-font-body': themeFonts.ui, '--buddy-font-mono': themeFonts.mono },
    }]
  })),
}

export default defineConfig({
  root: fileURLToPath(new URL('./src/mobile-reader', import.meta.url)),
  base: './',
  plugins: [vue(), UnoCSS(unoConfig), {
    name: 'mobile-appearance',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'appearance.json', source: JSON.stringify(appearance) })
    },
  }],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@buddy-shared': fileURLToPath(new URL('./shared', import.meta.url)),
      '@buddy-electron': fileURLToPath(new URL('./electron', import.meta.url)),
    },
  },
  build: {
    rollupOptions: { input: { reader: fileURLToPath(new URL('./src/mobile-reader/index.html', import.meta.url)), document: fileURLToPath(new URL('./src/mobile-reader/document.html', import.meta.url)) } },
    target: 'chrome83',
    assetsInlineLimit: 0,
    cssTarget: 'chrome83',
    outDir: fileURLToPath(new URL('./.output/build/mobile-reader', import.meta.url)),
    emptyOutDir: true,
  },
})
