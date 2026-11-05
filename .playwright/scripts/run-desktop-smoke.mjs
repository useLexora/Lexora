import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { runGuiSmoke } from '../../packaging/buddy/ci/run-gui-smoke.mjs'

const appPath = fileURLToPath(new URL('../../apps/buddy', import.meta.url))
const require = createRequire(new URL('../../apps/buddy/package.json', import.meta.url))
const [executable, application] = process.argv.slice(2)
process.env.LEXORA_BUDDY_PROFILE = 'test'

try {
  await runGuiSmoke({
    desktopOnly: true,
    desktopPath: executable ? resolve(executable) : require('electron'),
    desktopArgs: application ? [resolve(application)] : executable ? [] : [appPath],
  })
}
catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
  process.exitCode = 1
}
