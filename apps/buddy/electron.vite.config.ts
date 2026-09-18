import type { Plugin } from 'vite'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import vue from '@vitejs/plugin-vue'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import UnoCSS from 'unocss/vite'

const PRODUCTION_CONNECT_SRC = 'connect-src \'self\';'
const DEVELOPMENT_CONNECT_SRC
  = 'connect-src \'self\' ws://localhost:* ws://127.0.0.1:*;'

function allowDevelopmentWebSockets(): Plugin {
  return {
    name: 'lexora-buddy-development-csp',
    apply: 'serve',
    transformIndexHtml(html) {
      return html.replace(PRODUCTION_CONNECT_SRC, DEVELOPMENT_CONNECT_SRC)
    },
  }
}

const buddyVersion = JSON.parse(
  readFileSync(new URL('./buddy.version.json', import.meta.url), 'utf8'),
) as { version?: string }
const electronOutputRoot = fileURLToPath(
  new URL('./.output/build/electron', import.meta.url),
)
const electronCacheRoot = fileURLToPath(
  new URL('./.output/cache/electron-vite', import.meta.url),
)

export default defineConfig({
  main: {
    cacheDir: join(electronCacheRoot, 'main'),
    plugins: [externalizeDepsPlugin({ exclude: ['typescript'] })],
    build: {
      outDir: join(electronOutputRoot, 'main'),
      rollupOptions: {
        external: ['electron', '@silvia-odwyer/photon-node'],
        input: {
          'index': fileURLToPath(new URL('./electron/main/index.ts', import.meta.url)),
          'buddy-service': fileURLToPath(new URL('./service/src/index.ts', import.meta.url)),
          'extension-compiler': fileURLToPath(new URL('./electron/main/extensions/compilerProcess.ts', import.meta.url)),
        },
        output: {
          format: 'es',
          banner: chunk => chunk.name === 'extension-compiler' ? 'import { fileURLToPath as compilerFilePath } from "node:url"; import { dirname as compilerDirname } from "node:path"; const __filename = compilerFilePath(import.meta.url); const __dirname = compilerDirname(__filename);' : '',
        },
      },
    },
  },
  preload: {
    cacheDir: join(electronCacheRoot, 'preload'),
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: join(electronOutputRoot, 'preload'),
      rollupOptions: {
        external: ['electron'],
        input: {
          index: fileURLToPath(new URL('./electron/preload/index.ts', import.meta.url)),
          extensionHost: fileURLToPath(new URL('./electron/preload/extensionHost.ts', import.meta.url)),
        },
        output: {
          format: 'cjs',
        },
      },
    },
  },
  renderer: {
    cacheDir: join(electronCacheRoot, 'renderer'),
    root: fileURLToPath(new URL('.', import.meta.url)),
    define: {
      __LEXORA_BUDDY_VERSION__: JSON.stringify(buddyVersion.version ?? ''),
    },
    plugins: [
      allowDevelopmentWebSockets(),
      vue(),
      UnoCSS(),
    ],
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
        '@buddy-electron': fileURLToPath(new URL('./electron', import.meta.url)),
        '@buddy-shared': fileURLToPath(new URL('./shared', import.meta.url)),
      },
    },
    server: {
      port: 1420,
      strictPort: true,
    },
    build: {
      outDir: join(electronOutputRoot, 'renderer'),
      target: 'esnext',
      rollupOptions: {
        input: fileURLToPath(new URL('./index.html', import.meta.url)),
      },
    },
  },
})
