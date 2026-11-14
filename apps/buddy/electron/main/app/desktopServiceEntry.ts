import type { LocalServiceLaunchOptions } from '../../../platform/service/launchLocalService'
import { randomUUID } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { app, dialog } from 'electron'
import originalFs from 'original-fs'
import buddyPackage from '../../../package.json'
import { ensurePrivateDirectoriesSync } from '../../../platform/filesystem/privateDirectories'
import { resolveBuddyPrivateDirectories } from '../../../platform/native/nativeHost'
import { launchLocalService } from '../../../platform/service/launchLocalService'
import { acquireStorageRootLease } from '../../../platform/storage/StorageRootLease'
import { resolveBuddyRuntimePaths } from '../paths'
import { INSTALLER_EXIT_ARGUMENT, resolveDesktopLaunchIntent } from '../startupIntent'
import { requestPersistenceUpgrade } from '../storage/requestPersistenceUpgrade'
import { prepareStorageBootstrap, readStorageBootstrap } from '../storage/storageBootstrap'

export async function startDesktopServiceEntry(): Promise<boolean> {
  if (process.argv.includes('--lexora-platform-host') || process.argv.includes('--lexora-storage-maintenance') || process.env.LEXORA_BUDDY_SERVICE_MODE === 'utility' || (!app.isPackaged && process.env.LEXORA_BUDDY_SERVICE_MODE !== 'daemon'))
    return false
  try {
    const paths = resolveBuddyRuntimePaths({
      defaultUserData: app.getPath('userData'),
      desktopName: buddyPackage.desktopName,
      isPackaged: app.isPackaged,
      localAppData: process.env.LOCALAPPDATA,
      lexoraHomeOverride: process.env.LEXORA_HOME,
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
    const storage = readStorageBootstrap(paths.lexoraHome)
    const previousUserData = app.getPath('userData')
    const previousSessionData = app.getPath('sessionData')
    const launcherData = join(storage.bootstrapRoot, 'launcher')
    ensurePrivateDirectoriesSync([launcherData], resolveBuddyPrivateDirectories({ appPath: app.getAppPath(), resourcesPath: process.resourcesPath, isPackaged: app.isPackaged }))
    app.setName(paths.appName)
    app.setPath('userData', launcherData)
    app.setPath('sessionData', launcherData)
    const platformArguments = ['ozone-platform', 'password-store', 'user-data-dir', 'disable-gpu', 'disable-setuid-sandbox'].flatMap((name) => {
      if (!app.commandLine.hasSwitch(name))
        return []
      const value = app.commandLine.getSwitchValue(name)
      return [value ? `--${name}=${value}` : `--${name}`]
    })
    const options: LocalServiceLaunchOptions = {
      releaseFileSystem: originalFs,
      releaseSetPath: app.isPackaged ? join(process.resourcesPath, 'release-set.json') : join(app.getAppPath(), '.output/release-set.json'),
      profileRoot: storage.state.activeRoot,
      defaultRoot: paths.lexoraHome,
      profile: paths.profile,
      hostExecutable: process.execPath,
      hostArguments: [...platformArguments, ...app.isPackaged ? [] : [app.getAppPath()]],
      leaseDirectory: join(paths.profile === 'test' ? dirname(paths.lexoraHome) : homedir(), '.lexora-locations', 'locks'),
      storageAuthority: 'sqlite',
    }
    let connection = await launchLocalService({ ...options, startIfMissing: false })
    if (!connection && !process.argv.includes(INSTALLER_EXIT_ARGUMENT)) {
      const release = acquireStorageRootLease(storage.state.activeRoot, options.leaseDirectory, resolveBuddyPrivateDirectories({ appPath: app.getAppPath(), resourcesPath: process.resourcesPath, isPackaged: app.isPackaged }))
      let maintenance: boolean
      try {
        const prepared = prepareStorageBootstrap(paths, resolveBuddyPrivateDirectories({ appPath: app.getAppPath(), resourcesPath: process.resourcesPath, isPackaged: app.isPackaged }))
        await requestPersistenceUpgrade(prepared)
        maintenance = !!(await prepared.store.read()).pending
      }
      finally { release() }
      if (maintenance) {
        app.setPath('userData', previousUserData)
        app.setPath('sessionData', previousSessionData)
        return false
      }
      connection = await launchLocalService(options)
    }
    if (!connection) {
      app.exit(0)
      return true
    }
    try {
      if (process.argv.includes(INSTALLER_EXIT_ARGUMENT)) {
        await connection.peer.request('service.stop', { expectedServiceInstanceId: connection.discovery.serviceInstanceId, commandId: randomUUID(), reason: 'maintenance' })
        await connection.waitForExit()
      }
      else if (resolveDesktopLaunchIntent(process.argv, process.platform === 'darwin' && app.getLoginItemSettings().wasOpenedAtLogin) === 'foreground') {
        await connection.peer.request('service.openDesktop', { expectedServiceInstanceId: connection.discovery.serviceInstanceId, intent: { kind: 'tasks' } })
      }
    }
    finally { connection.peer.close(new Error('SERVICE_LAUNCHER_FINISHED')) }
    app.exit(0)
  }
  catch (error) {
    await app.whenReady()
    const code = error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : 'SERVICE_START_FAILED'
    process.stderr.write(`${code}\n`)
    dialog.showErrorBox('Lexora', `无法启动后台服务。请保留当前数据并重试。\n${code}`)
    app.exit(1)
  }
  return true
}
