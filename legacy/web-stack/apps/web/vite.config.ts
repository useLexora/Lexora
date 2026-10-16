import process from 'node:process'
import { fileURLToPath, URL } from 'node:url'
import { SERVER_PATH, SERVER_PORT } from '@haohaoxue/lexora-contracts/server'
import vue from '@vitejs/plugin-vue'
import vueJsx from '@vitejs/plugin-vue-jsx'
import UnoCSS from 'unocss/vite'
import ElementPlus from 'unplugin-element-plus/vite'
import { ElementPlusResolver } from 'unplugin-vue-components/resolvers'
import Components from 'unplugin-vue-components/vite'
import { loadEnv } from 'vite'
import { defineConfig } from 'vitest/config'

const elementPlusResolver = ElementPlusResolver({
  importStyle: 'css',
})

const editorDependencyDedupe = [
  '@tiptap/core',
  '@tiptap/pm',
  '@tiptap/starter-kit',
  '@tiptap/vue-3',
  'prosemirror-model',
  'prosemirror-state',
  'prosemirror-transform',
  'prosemirror-view',
]

const editorOptimizedDependencies = [
  '@tiptap/core',
  '@tiptap/extension-color',
  '@tiptap/extension-highlight',
  '@tiptap/extension-image',
  '@tiptap/extension-placeholder',
  '@tiptap/extension-table',
  '@tiptap/extension-table-cell',
  '@tiptap/extension-table-header',
  '@tiptap/extension-table-row',
  '@tiptap/extension-task-item',
  '@tiptap/extension-task-list',
  '@tiptap/extension-text-style',
  '@tiptap/pm/model',
  '@tiptap/pm/state',
  '@tiptap/pm/view',
  '@tiptap/starter-kit',
  '@tiptap/vue-3',
  '@tiptap/vue-3/menus',
  'prosemirror-model',
  'prosemirror-state',
  'prosemirror-transform',
  'prosemirror-view',
  'element-plus/es',
]

const codeSplittingGroups = [
  {
    name: 'vue-core',
    test: /[/\\](vue|vue-router|pinia)[/\\]/,
    priority: 40,
  },
  {
    name: 'vueuse',
    test: /[/\\]@vueuse[/\\]/,
    priority: 30,
  },
  {
    name: 'tiptap-katex',
    test: /[/\\]katex[/\\]/,
    priority: 20,
  },
  {
    name: 'tiptap-highlight',
    test: /[/\\](highlight\.js|lowlight)[/\\]/,
    priority: 20,
  },
]

export default defineConfig(({ mode }) => {
  loadEnv(mode, process.cwd(), '')

  return {
    plugins: [
      vue(),
      vueJsx(),
      UnoCSS(),
      Components({
        dts: './components.d.ts',
        resolvers: [elementPlusResolver],
      }),
      ElementPlus({}),
    ],
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
      dedupe: editorDependencyDedupe,
    },
    optimizeDeps: {
      include: editorOptimizedDependencies,
    },
    server: {
      proxy: {
        [SERVER_PATH]: {
          target: `http://localhost:${SERVER_PORT}`,
          changeOrigin: true,
          xfwd: true,
          ws: true,
        },
      },
    },
    build: {
      target: 'esnext',
      rolldownOptions: {
        checks: {
          invalidAnnotation: false,
        },
        output: {
          codeSplitting: {
            groups: codeSplittingGroups,
          },
        },
      },
    },
    test: {
      environment: 'jsdom',
      include: ['./__tests__/**/*.spec.ts', './src/**/__tests__/**/*.spec.ts'],
      maxWorkers: 2,
      server: {
        deps: {
          inline: ['element-plus'],
        },
      },
      setupFiles: './__tests__/setup.ts',
    },
  }
})
