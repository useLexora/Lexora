import type { Plugin } from 'vite'
import { existsSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { isBuiltin } from 'node:module'
import { basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

const externalPackages = new Set(['@earendil-works/pi-codemode', '@silvia-odwyer/photon-node'])

function packageName(id: string) {
  return id.startsWith('@') ? id.split('/').slice(0, 2).join('/') : id.split('/')[0]!
}

function serviceResources(): Plugin {
  return {
    name: 'lexora-service-resources',
    enforce: 'pre',
    buildStart() {
      // Pi resolves the resize worker relative to the chunk containing resizeImage.
      const worker = new URL('./utils/image-resize-worker.js', import.meta.resolve('@earendil-works/pi-coding-agent'))
      this.emitFile({ type: 'chunk', id: fileURLToPath(worker), fileName: 'assets/image-resize-worker.js' })
    },
    async load(id) {
      if (!id.endsWith('?asset'))
        return
      const source = id.slice(0, -6)
      const reference = this.emitFile({ type: 'asset', name: basename(source), source: await readFile(source) })
      return `import { fileURLToPath } from 'node:url'; export default fileURLToPath(import.meta.ROLLUP_FILE_URL_${reference});`
    },
    resolveFileUrl({ relativePath }) { return `new URL(${JSON.stringify(relativePath)}, import.meta.url).href` },
    generateBundle(_options, bundle) {
      // The bundled Pi SDK resolves quickjs-wasi/quickjs.wasm via createRequire, not an import.
      const dependencies = new Set(['quickjs-wasi'])
      for (const file of Object.values(bundle)) {
        if (file.type !== 'chunk')
          continue
        for (const id of [...file.imports, ...file.dynamicImports]) {
          if (isBuiltin(id) || id.startsWith('.') || Object.hasOwn(bundle, id))
            continue
          dependencies.add(packageName(id))
        }
      }
      this.emitFile({ type: 'asset', fileName: 'dependencies.json', source: `${JSON.stringify([...dependencies].sort(), null, 2)}\n` })

      const bundled = new Map<string, { name: string, version: string, identifier?: string }>()
      for (const moduleId of this.getModuleIds()) {
        const match = moduleId.match(/node_modules\/(?:@[^/]+\/[^/]+|[^/]+)/)
        if (!match)
          continue
        const pkgRel = match[0]
        try {
          const pkgJsonPath = fileURLToPath(new URL(`./${pkgRel}/package.json`, import.meta.url))
          if (existsSync(pkgJsonPath)) {
            const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as { name?: string, version?: string, license?: string }
            if (pkg.name && pkg.version && !dependencies.has(pkg.name) && !bundled.has(pkg.name))
              bundled.set(pkg.name, { name: pkg.name, version: pkg.version, identifier: pkg.license })
          }
        }
        catch {}
      }
      const bundledList = [...bundled.values()].sort((a, b) => a.name.localeCompare(b.name))
      this.emitFile({ type: 'asset', fileName: 'third-party/service-bundled.json', source: `${JSON.stringify(bundledList, null, 2)}\n` })
    },
  }
}

export default defineConfig({
  plugins: [serviceResources()],
  ssr: { noExternal: true },
  build: {
    ssr: true,
    outDir: '.output/build/service',
    target: 'node26',
    minify: false,
    license: false,
    ssrEmitAssets: true,
    rolldownOptions: {
      input: {
        service: fileURLToPath(new URL('./service/src/entry.ts', import.meta.url)),
        utility: fileURLToPath(new URL('./electron/main/runtime/serviceProcess.ts', import.meta.url)),
      },
      // Keep worker and WASM loaders next to their package-owned resources.
      external: id => isBuiltin(id) || id.startsWith('node:') || externalPackages.has(packageName(id)),
      output: { entryFileNames: '[name].mjs', format: 'es' },
    },
  },
})
