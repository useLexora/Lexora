import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { prepareElectronDownload } from '../../packaging/buddy/release/electron-download.mjs'

const require = createRequire(new URL('../../apps/buddy/package.json', import.meta.url))

export async function prepareTestElectron(output) {
  const destination = resolve(output)
  if (existsSync(destination))
    throw new Error(`Electron test destination already exists: ${destination}`)
  const electronRequire = createRequire(require.resolve('electron/package.json'))
  const staging = mkdtempSync(join(tmpdir(), 'lexora-test-electron-'))
  try {
    const { version, path: zip } = await prepareElectronDownload({ cacheRoot: staging })
    const { extract } = electronRequire('@electron-internal/extract-zip')
    mkdirSync(destination)
    try {
      await extract(zip, { dir: destination })
      const executable = process.platform === 'darwin'
        ? 'Electron.app/Contents/MacOS/Electron'
        : process.platform === 'win32' ? 'electron.exe' : 'electron'
      const installed = execFileSync(join(destination, executable), ['-p', 'process.versions.electron'], {
        encoding: 'utf8',
        env: { ...process.env, GH_TOKEN: undefined, GITHUB_TOKEN: undefined, ELECTRON_RUN_AS_NODE: '1' },
        timeout: 15_000,
      }).trim()
      if (installed !== version)
        throw new Error(`Unexpected Electron test version: ${installed}`)
    }
    catch (error) {
      rmSync(destination, { recursive: true, force: true })
      throw error
    }
    return { version, directory: destination }
  }
  finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2])
    throw new Error('Usage: prepare-test-electron.mjs <new-directory>')
  const result = await prepareTestElectron(process.argv[2])
  process.stdout.write(`Prepared Electron ${result.version}: ${result.directory}\n`)
}
