import { spawnSync } from 'node:child_process'
import process from 'node:process'
import { app } from 'electron'
import { resolveBuddyProcessControl } from '../../../platform/native/nativeHost'
import { INSTALLER_EXIT_ARGUMENT } from '../startupIntent'

export function isDesktopInstallationActive(): boolean {
  if (!['win32', 'linux'].includes(process.platform) || !app.isPackaged || process.argv.includes(INSTALLER_EXIT_ARGUMENT))
    return false
  const helper = resolveBuddyProcessControl({ appPath: app.getAppPath(), isPackaged: true, resourcesPath: process.resourcesPath })
  if (!helper)
    throw new Error('INSTALLATION_CHECK_UNAVAILABLE')
  const result = spawnSync(helper, [process.platform === 'linux' ? '--check-linux-update' : '--check-installation'], { timeout: 5_000, windowsHide: true, stdio: 'ignore' })
  if (result.status === 32)
    return true
  if (result.status !== 0 || result.error)
    throw new Error('INSTALLATION_CHECK_FAILED', { cause: result.error })
  return false
}
