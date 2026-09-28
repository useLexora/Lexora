import type { Plugin } from 'vite'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'

export function extensionRuntimePlugin(): Plugin {
  const prefix = 'virtual:extension-runtime/'
  return {
    name: 'lexora-extension-runtime',
    resolveId(id) {
      if (id === `${prefix}host` || id === `${prefix}view`)
        return `\0${id}`
    },
    async load(id) {
      if (!id.startsWith(`\0${prefix}`))
        return
      const kind = id.slice(prefix.length + 1)
      const result = await build({
        configFile: false,
        envFile: false,
        logLevel: 'silent',
        build: { write: false, minify: false, target: 'esnext', lib: { entry: fileURLToPath(new URL(`./main/extensions/runtime/${kind}.js`, import.meta.url)), formats: ['es'] } },
      })
      const chunks = (Array.isArray(result) ? result.flatMap(item => item.output) : 'output' in result ? result.output : []).filter(item => item.type === 'chunk')
      if (chunks.length !== 1 || chunks[0]!.imports.length)
        throw new Error('Extension runtime must be a self-contained browser module')
      for (const path of Object.keys(chunks[0]!.modules))
        this.addWatchFile(path)
      return `export default ${JSON.stringify(chunks[0]!.code)}`
    },
  }
}
