import { spawn } from 'node:child_process'
import { once } from 'node:events'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WindowsSystemHost } from '../../../service/src/system/adapters/windows/WindowsSystemHost'
import { createBuddyNativeEnvironment } from '../../native/nativeHost'

const nativePaths = { appPath: fileURLToPath(new URL('../../../', import.meta.url)), resourcesPath: '', isPackaged: false }

describe.skipIf(process.platform !== 'win32')('windows native host', () => {
  beforeEach(() => {
    for (const [name, value] of Object.entries(createBuddyNativeEnvironment(nativePaths)))
      vi.stubEnv(name, value)
  })
  it('resolves and force-stops only its own disposable child by pinned identity', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true, stdio: 'ignore' })
    const exited = once(child, 'exit')
    try {
      await once(child, 'spawn')
      if (!child.pid)
        throw new Error('Disposable child did not start')
      const host = new WindowsSystemHost()
      const signal = AbortSignal.timeout(45_000)
      const targets = await host.resolveTargets({ kind: 'process', pid: child.pid }, signal)
      expect(targets).toHaveLength(1)
      const target = targets[0]!
      expect(target.allowedActions).toContain('kill-process')
      await host.execute(target, 'kill-process', signal)
      await exited
      expect(await host.readTarget(target, signal)).toBeNull()
    }
    finally {
      if (child.exitCode === null && child.signalCode === null)
        child.kill()
      await exited
    }
  }, 60_000)
})
