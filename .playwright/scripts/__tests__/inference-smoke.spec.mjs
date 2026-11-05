import { createRequire } from 'node:module'
import { join } from 'node:path'
import process from 'node:process'
import inferenceBootstrap from 'virtual:extension-runtime/inference'
import { describe, expect, it } from 'vitest'
import { runDesktopSmoke } from '../../../packaging/buddy/ci/run-gui-smoke.mjs'
import { checkInferenceSmoke } from '../fixtures/inference-smoke.ts'
import { ROOT } from '../shared.mjs'

const require = createRequire(join(ROOT, 'apps/buddy/package.json'))
const options = {
  bootstrap: inferenceBootstrap,
  executable: require('electron'),
  sandbox: join(ROOT, 'apps/buddy/.output/build/shell-sandbox/linux-x64/bwrap'),
  appVersion: require('./package.json').version,
}

describe.runIf(process.platform === 'linux' && process.arch === 'x64')('native inference smoke with source modules and prepared runtimes', () => {
  it('stages a plugin, handshakes through bwrap, round-trips binary input and reclaims the process and resource lease', async () => {
    await checkInferenceSmoke(options)
  }, 30_000)

  it('rejects an embedded worker that exits before the handshake', async () => {
    await expect(checkInferenceSmoke({ ...options, bootstrap: 'process.exit(2)' })).rejects.toThrow('EXTENSION_INFERENCE_PROCESS_EXITED')
  }, 30_000)

  it('rejects a host that exits successfully without inference verification', async () => {
    await expect(runDesktopSmoke(process.execPath, process.env, 10_000, ['-e', 'process.exit(0)'])).rejects.toThrow('without native inference handshake')
  })
})
