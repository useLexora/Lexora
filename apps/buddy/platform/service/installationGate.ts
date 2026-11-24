import { spawnSync } from 'node:child_process'
import process from 'node:process'

export function installationActive(helper: string | undefined) {
  if (process.platform !== 'win32' && process.platform !== 'linux')
    return false
  if (!helper)
    throw new Error('INSTALLATION_CHECK_UNAVAILABLE')
  const result = spawnSync(helper, [process.platform === 'linux' ? '--check-linux-update' : '--check-installation'], { timeout: 5_000, windowsHide: true, stdio: 'ignore' })
  if (result.status === 32)
    return true
  if (result.status !== 0 || result.error)
    throw new Error('INSTALLATION_CHECK_FAILED', { cause: result.error })
  return false
}
