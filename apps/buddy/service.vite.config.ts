import type { Plugin } from 'vite'
import { readFile } from 'node:fs/promises'
import { isBuiltin } from 'node:module'
import { basename, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

function serviceResources(): Plugin {
  return {
    name: 'lexora-service-resources',
    enforce: 'pre',
    async load(id) {
      if (!id.endsWith('?asset'))
        return
      const source = id.slice(0, -6)
      const reference = this.emitFile({ type: 'asset', name: basename(source), source: await readFile(source) })
      return `import { fileURLToPath } from 'node:url'; export default fileURLToPath(import.meta.ROLLUP_FILE_URL_${reference});`
    },
    resolveFileUrl({ relativePath }) { return `new URL(${JSON.stringify(relativePath)}, import.meta.url).href` },
    generateBundle(_options, bundle) {
      const dependencies = new Set<string>()
      for (const file of Object.values(bundle)) {
        if (file.type !== 'chunk')
          continue
        for (const id of [...file.imports, ...file.dynamicImports]) {
          if (isBuiltin(id) || id.startsWith('.') || Object.hasOwn(bundle, id))
            continue
          dependencies.add(id.startsWith('@') ? id.split('/').slice(0, 2).join('/') : id.split('/')[0]!)
        }
      }
      this.emitFile({ type: 'asset', fileName: 'dependencies.json', source: `${JSON.stringify([...dependencies].sort(), null, 2)}\n` })
    },
  }
}

export default defineConfig({
  plugins: [serviceResources()],
  ssr: { noExternal: ['fflate'] },
  build: {
    ssr: fileURLToPath(new URL('./service/src/index.ts', import.meta.url)),
    outDir: '.output/build/service',
    target: 'node26',
    minify: false,
    ssrEmitAssets: true,
    rolldownOptions: {
      external: id => id !== 'fflate/browser' && !id.startsWith('.') && !isAbsolute(id) && !id.startsWith('\0'),
      output: { entryFileNames: 'service.mjs', format: 'es' },
    },
  },
})
