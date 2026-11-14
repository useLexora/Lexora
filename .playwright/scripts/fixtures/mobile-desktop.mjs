import { createRequire, isBuiltin } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('../../../', import.meta.url))

export async function prepareMobileDesktopProfile(home, output) {
  const requireBuddy = createRequire(path.join(root, 'apps/buddy/package.json'))
  const { build } = await import(pathToFileURL(requireBuddy.resolve('vite')).href)
  await build({ configFile: false, logLevel: 'error', build: {
    ssr: path.join(root, '.playwright/scripts/__tests__/prepareProductProfile.ts'),
    outDir: output,
    target: 'node26',
    rolldownOptions: { external: isBuiltin, output: { entryFileNames: 'prepare.mjs', format: 'es' } },
  } })
  const { prepareProductProfile } = await import(pathToFileURL(path.join(output, 'prepare.mjs')).href)
  prepareProductProfile(home)
}
