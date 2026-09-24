import { readFileSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'
import vue from '@vitejs/plugin-vue'
import UnoCSS from 'unocss/vite'
import { defineConfig } from 'vitest/config'

const buddyVersion = JSON.parse(
  readFileSync(new URL('./buddy.version.json', import.meta.url), 'utf8'),
) as { version?: string }

export default defineConfig({
  cacheDir: fileURLToPath(new URL('./.output/cache/vite', import.meta.url)),
  define: {
    __LEXORA_BUDDY_VERSION__: JSON.stringify(buddyVersion.version ?? ''),
  },
  plugins: [
    {
      name: 'electron-node-asset-path',
      enforce: 'pre',
      load(id) {
        if (id.endsWith('?asset'))
          return `export default ${JSON.stringify(id.slice(0, -'?asset'.length))}`
      },
    },
    vue(),
    UnoCSS(),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@buddy-electron': fileURLToPath(new URL('./electron', import.meta.url)),
      '@buddy-shared': fileURLToPath(new URL('./shared', import.meta.url)),
      '@buddy-tests': fileURLToPath(new URL('./__tests__', import.meta.url)),
    },
  },
  server: {
    port: 1420,
    strictPort: true,
  },
  build: {
    outDir: fileURLToPath(new URL('./.output/build/renderer-preview', import.meta.url)),
    target: 'esnext',
  },
  test: {
    clearMocks: true,
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['{src,shared,eslint,__tests__}/**/*.{test,spec}.?(c|m)[jt]s?(x)'],
        },
      },
      {
        extends: true,
        test: {
          name: 'runtime',
          include: ['{service,electron}/**/*.{test,spec}.?(c|m)[jt]s?(x)'],
        },
      },
      {
        extends: true,
        test: {
          name: 'platform',
          include: ['platform/**/*.{test,spec}.?(c|m)[jt]s?(x)'],
        },
      },
    ],
    restoreMocks: true,
    setupFiles: './vitest.setup.ts',
    unstubEnvs: true,
    unstubGlobals: true,
  },
})
