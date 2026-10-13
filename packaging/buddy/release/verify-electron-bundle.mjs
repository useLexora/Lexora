import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { writeOutput } from '../../shared/cli-output.mjs'

const repoRoot = resolve(import.meta.dirname, '../../..')
const bundleRoot = 'apps/buddy/.output/build/electron'

export function verifyElectronBundle(cwd = repoRoot) {
  const errors = []
  const read = path => readFileSync(resolve(cwd, path), 'utf8')
  const main = read(`${bundleRoot}/main/index.js`)
  const service = read(`${bundleRoot}/main/buddy-service.js`)
  const preload = read(`${bundleRoot}/preload/index.cjs`)
  const renderer = read(`${bundleRoot}/renderer/index.html`)
  for (const [name, content] of [['main', main], ['service', service], ['preload', preload]]) {
    if (['Downloading Electron binary', 'node_modules/electron/index.js'].some(fragment => content.includes(fragment)))
      errors.push(`${name} bundles the Electron installer instead of the runtime external`)
  }
  if (!main.includes('from "electron"') && !main.includes('require("electron")'))
    errors.push('Electron main must keep Electron external')
  if (!preload.includes('require("electron")') || preload.includes('from "electron"'))
    errors.push('Sandbox preload must use CommonJS Electron')
  if (!service.includes('.parentPort') || service.includes('from "electron"') || service.includes('require("electron")'))
    errors.push('Local Service must use process.parentPort without importing Electron')
  if (/connect-src[^;]*(?:localhost|127\.0\.0\.1)/.test(renderer))
    errors.push('Production renderer CSP allows development WebSocket origins')

  for (const [source, runtime, size] of [
    ['packages/assets/brand/app-icon.png', 'apps/buddy/resources/icons/app-icon.png', 512],
    ['packages/assets/brand/tray-icon.png', 'apps/buddy/resources/icons/tray-icon.png', 256],
    ['packages/assets/brand/lexora-avatar.png', 'apps/buddy/resources/brand/lexora-avatar.png', 1254],
  ]) {
    const bytes = readFileSync(resolve(cwd, source))
    if (bytes.length < 24 || bytes.toString('hex', 0, 8) !== '89504e470d0a1a0a'
      || bytes.readUInt32BE(16) !== size || bytes.readUInt32BE(20) !== size) {
      errors.push(`${source} must be a ${size}x${size} PNG`)
    }
    if (!bytes.equals(readFileSync(resolve(cwd, runtime))))
      errors.push(`${runtime} must match ${source}`)
  }
  return errors
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const errors = verifyElectronBundle()
  if (errors.length)
    throw new Error(errors.join('\n'))
  writeOutput('Electron bundle check passed')
}
