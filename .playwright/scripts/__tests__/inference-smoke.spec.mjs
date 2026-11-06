import { createRequire } from 'node:module'
import { join } from 'node:path'
import process from 'node:process'
import inferenceBootstrap from 'virtual:extension-runtime/inference'
import { describe, expect, it } from 'vitest'
import { resolveBuddyProcessControl } from '../../../apps/buddy/platform/native/nativeHost.ts'
import { resolveInferenceEnvironment } from '../../../apps/buddy/shared/extensions/inferencePlatform.ts'
import { runDesktopSmoke } from '../../../packaging/buddy/ci/run-gui-smoke.mjs'
import { checkInferenceSmoke } from '../fixtures/inference-smoke.ts'
import { ROOT } from '../shared.mjs'

const require = createRequire(join(ROOT, 'apps/buddy/package.json'))

function inferenceOptions() {
  const appPath = join(ROOT, 'apps/buddy')
  return {
    bootstrap: inferenceBootstrap,
    executable: require('electron'),
    supervisor: resolveBuddyProcessControl({ appPath, isPackaged: false, resourcesPath: appPath }),
    sandbox: process.platform === 'linux' ? join(appPath, '.output/build/shell-sandbox/linux-x64/bwrap') : undefined,
    appVersion: require('./package.json').version,
  }
}

describe.runIf(resolveInferenceEnvironment(process.platform, process.arch).platform !== null)('native inference smoke with source modules and prepared runtimes', () => {
  it('stages a plugin, handshakes with the native runtime, round-trips near-limit binary input and reclaims the process and resource lease', async () => {
    await checkInferenceSmoke(inferenceOptions())
  }, 30_000)

  it('rejects an embedded worker that exits before the handshake', async () => {
    await expect(checkInferenceSmoke({ ...inferenceOptions(), bootstrap: 'process.exit(2)' })).rejects.toThrow('EXTENSION_INFERENCE_PROCESS_EXITED')
  }, 30_000)

  it('rejects a host that exits successfully without inference verification', async () => {
    await expect(runDesktopSmoke(process.execPath, process.env, 10_000, ['-e', 'process.exit(0)'])).rejects.toThrow('without native inference handshake')
  })
})

describe.runIf(resolveInferenceEnvironment(process.platform, process.arch).platform !== null)('desktop smoke inference markers', () => {
  it.each([
    { inference: 'build', expectedFormat: '' },
    { inference: 'packaged', expectedFormat: 'windows-zip' },
  ])('accepts a successful host with a valid $inference marker', async ({ inference, expectedFormat }) => {
    await expect(runDesktopSmoke(process.execPath, {
      ...process.env,
      LEXORA_DESKTOP_SMOKE_EXPECTED_FORMAT: expectedFormat,
    }, 10_000, ['-e', `console.log('LEXORA_INFERENCE_SMOKE:passed:${inference}')`])).resolves.toEqual({ inference })
  })

  it('rejects a build marker when packaged distribution verification is required', async () => {
    await expect(runDesktopSmoke(process.execPath, {
      ...process.env,
      LEXORA_DESKTOP_SMOKE_EXPECTED_FORMAT: 'windows-zip',
    }, 10_000, ['-e', 'console.log("LEXORA_INFERENCE_SMOKE:passed:build")'])).rejects.toThrow('expected packaged native inference verification')
  })
})
