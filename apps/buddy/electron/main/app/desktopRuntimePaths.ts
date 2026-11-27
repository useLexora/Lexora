import { homedir, tmpdir } from 'node:os'
import process from 'node:process'
import { app } from 'electron'
import buddyPackage from '../../../package.json'
import { resolveBuddyRuntimePaths } from '../paths'

export function resolveDesktopRuntimePaths() {
  return resolveBuddyRuntimePaths({
    defaultUserData: app.getPath('userData'),
    desktopName: buddyPackage.desktopName,
    isPackaged: app.isPackaged,
    localAppData: process.env.LOCALAPPDATA,
    lexoraHomeOverride: process.env.LEXORA_HOME,
    nativePetSocketOverride: process.env.LEXORA_BUDDY_PET_SOCKET,
    nativePetStateOverride: process.env.LEXORA_BUDDY_PET_STATE_PATH,
    profileOverride: process.env.LEXORA_BUDDY_PROFILE,
    smokeTest: process.env.LEXORA_DESKTOP_SMOKE_TEST === '1',
    temporaryDirectory: tmpdir(),
    userDataOverride: app.commandLine.hasSwitch('user-data-dir') ? app.commandLine.getSwitchValue('user-data-dir') : undefined,
    userHome: homedir(),
    userId: process.geteuid?.() ?? 0,
    xdgCacheHome: process.env.XDG_CACHE_HOME,
    xdgConfigHome: process.env.XDG_CONFIG_HOME,
    xdgRuntimeDirectory: process.env.XDG_RUNTIME_DIR,
    xdgStateHome: process.env.XDG_STATE_HOME,
  })
}
