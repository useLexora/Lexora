import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const workspace = fileURLToPath(new URL('../../', import.meta.url))
const buddy = path.join(workspace, 'apps/buddy')
const requireBuddy = createRequire(path.join(buddy, 'package.json'))
const mode = process.argv[2] ?? 'cost'
assert(process.argv.length <= 3 && ['cost', 'crash', 'capacity'].includes(mode), 'Usage: node .playwright/scripts/storage-durability.mjs [cost|crash|capacity]')
const root = path.join(workspace, '.playwright/runs', `storage-durability-${new Date().toISOString().replaceAll(/[:.]/g, '-')}`)
await fs.mkdir(root, { recursive: true })
await fs.symlink(path.join(buddy, 'node_modules'), path.join(root, 'node_modules'), 'junction')
try {
  const { build } = await import(pathToFileURL(requireBuddy.resolve('vite')))
  await build({
    configFile: false,
    logLevel: 'error',
    build: {
      ssr: fileURLToPath(new URL(`./__tests__/${mode === 'crash' ? 'storageCrash' : mode === 'capacity' ? 'commandCapacity' : 'storageDurability'}.ts`, import.meta.url)),
      outDir: root,
      emptyOutDir: false,
      target: 'node26',
      minify: false,
      rollupOptions: {
        external: id => !id.startsWith('.') && !path.isAbsolute(id) && !id.startsWith('\0'),
        output: { entryFileNames: 'storage.mjs' },
      },
    },
  })
  const bundle = path.join(root, 'storage.mjs')
  const bundleSha256 = createHash('sha256').update(await fs.readFile(bundle)).digest('hex')
  const api = await import(pathToFileURL(bundle))
  if (mode === 'crash')
    await api.runStorageCrashes(root, bundle, bundleSha256)
  else if (mode === 'capacity')
    await api.runCommandCapacity(root, bundleSha256)
  else
    await api.runStorageDurability(root, bundleSha256)
}
finally {
  await fs.unlink(path.join(root, 'node_modules'))
  process.stdout.write(`Storage durability artifacts: ${root}\n`)
}
