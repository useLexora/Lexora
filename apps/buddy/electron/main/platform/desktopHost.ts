import type { BuddyPlatformId } from '../../../shared/platform'
import process from 'node:process'
import { app } from 'electron'
import { resolveLinuxConfigDirectory, syncLinuxAutostart } from '../linuxAutostart'

interface DesktopHost {
  setIdentity?: (desktopName: string) => void
  setAutostart: (enabled: boolean) => Promise<void>
}

export const desktopHosts: Record<BuddyPlatformId, DesktopHost> = {
  darwin: {
    async setAutostart(enabled) {
      app.setLoginItemSettings({ openAtLogin: enabled })
    },
  },
  linux: {
    setIdentity: name => app.setDesktopName(name),
    setAutostart: enabled => syncLinuxAutostart({
      configDirectory: resolveLinuxConfigDirectory(app.getPath('home'), process.env.XDG_CONFIG_HOME),
      enabled,
      executablePath: process.execPath,
    }),
  },
  win32: {
    setIdentity: name => app.setAppUserModelId(name),
    async setAutostart(enabled) {
      app.setLoginItemSettings({ args: ['--background'], openAtLogin: enabled })
    },
  },
}
