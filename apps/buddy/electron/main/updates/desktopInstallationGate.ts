import process from 'node:process'
import { app } from 'electron'
import { resolveBuddyProcessControl } from '../../../platform/native/nativeHost'
import { installationActive } from '../../../platform/service/installationGate'
import { INSTALLER_EXIT_ARGUMENT } from '../startupIntent'

export function isDesktopInstallationActive(): boolean {
  if (!['win32', 'linux'].includes(process.platform) || !app.isPackaged || process.argv.includes(INSTALLER_EXIT_ARGUMENT))
    return false
  const helper = resolveBuddyProcessControl({ appPath: app.getAppPath(), isPackaged: true, resourcesPath: process.resourcesPath })
  return installationActive(helper)
}
