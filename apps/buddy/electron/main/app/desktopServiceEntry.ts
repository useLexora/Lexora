import type { LocalServiceLaunchOptions } from '../../../platform/service/launchLocalService'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { app, dialog, powerMonitor } from 'electron'
import originalFs from 'original-fs'
import { ensurePrivateDirectoriesSync } from '../../../platform/filesystem/privateDirectories'
import { RuntimeRemoteError, RuntimeRequestTimeoutError } from '../../../platform/ipc/runtimeRpcPeer'
import { resolveBuddyPrivateDirectories } from '../../../platform/native/nativeHost'
import { prepareLocalServiceLauncher } from '../../../platform/service/launchLocalService'
import { createPrivateStartupRecord } from '../../../platform/service/privateStartupRecord'
import { storageBootstrapRoot } from '../../../platform/storage/StorageLocationStore'
import { acquireStorageRootLease } from '../../../platform/storage/StorageRootLease'
import { desktopOpenResultSchema } from '../../../shared/service/localServiceProtocol'
import { INSTALLER_EXIT_ARGUMENT, resolveDesktopLaunchIntent } from '../startupIntent'
import { prepareStorageBootstrap, readStorageBootstrap } from '../storage/storageBootstrap'
import { resolveDesktopRuntimePaths } from './desktopRuntimePaths'

export async function startDesktopServiceEntry(allowReady?: () => void): Promise<boolean> {
  const platformHost = process.argv.includes('--lexora-platform-host')
  const maintenance = process.argv.includes('--lexora-storage-maintenance')
  if (platformHost || maintenance || process.env.LEXORA_BUDDY_SERVICE_MODE === 'utility' || (!app.isPackaged && process.env.LEXORA_BUDDY_SERVICE_MODE !== 'daemon')) {
    if (process.platform === 'win32')
      app.setPath('sessionData', join(storageBootstrapRoot(resolveDesktopRuntimePaths().lexoraHome), 'migration-session'))
    return false
  }
  const installerExit = process.argv.includes(INSTALLER_EXIT_ARGUMENT)
  let foreground = !installerExit && resolveDesktopLaunchIntent(process.argv) === 'foreground'
  let evidence: ReturnType<typeof createPrivateStartupRecord> | undefined
  let stage: 'connect' | 'storage' | 'service_start' = 'connect'
  try {
    const paths = resolveDesktopRuntimePaths()
    const previousUserData = app.getPath('userData')
    const previousSessionData = app.getPath('sessionData')
    if (process.platform === 'win32')
      app.setPath('sessionData', join(storageBootstrapRoot(paths.lexoraHome), 'launcher'))
    const releaseSetPath = app.isPackaged ? join(process.resourcesPath, 'release-set.json') : join(app.getAppPath(), '.output/release-set.json')
    const launcher = await prepareLocalServiceLauncher(releaseSetPath, paths.lexoraHome, installerExit ? 'quit_for_install' : 'launch', originalFs)
    const storage = readStorageBootstrap(paths.lexoraHome)
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
    if (process.platform === 'darwin' && !installerExit)
      await app.whenReady()
    foreground = foreground && !(process.platform === 'darwin' && app.getLoginItemSettings().wasOpenedAtLogin)
    if (foreground && launcher.buildId) {
      evidence = createPrivateStartupRecord(launcherData, 'launcher', launcher.buildId)
      void evidence(stage, 'pending')
    }
    const options: LocalServiceLaunchOptions = {
      profileRoot: storage.state.activeRoot,
      defaultRoot: paths.lexoraHome,
      profile: paths.profile,
      hostExecutable: process.execPath,
      hostArguments: [...platformArguments, ...app.isPackaged ? [] : [app.getAppPath()]],
      leaseDirectory: join(paths.profile === 'test' ? dirname(paths.lexoraHome) : homedir(), '.lexora-locations', 'locks'),
      storageAuthority: 'sqlite',
      connectDuringStartup: foreground || installerExit,
    }
    let connection = await launcher.connect(options)
    if (!connection && launcher.start) {
      stage = 'storage'
      void evidence?.(stage, 'pending')
      const release = acquireStorageRootLease(storage.state.activeRoot, options.leaseDirectory, resolveBuddyPrivateDirectories({ appPath: app.getAppPath(), resourcesPath: process.resourcesPath, isPackaged: app.isPackaged }))
      let maintenance: boolean
      try {
        const prepared = prepareStorageBootstrap(paths, resolveBuddyPrivateDirectories({ appPath: app.getAppPath(), resourcesPath: process.resourcesPath, isPackaged: app.isPackaged }))
        const { requestPersistenceUpgrade } = await import('../storage/requestPersistenceUpgrade')
        await requestPersistenceUpgrade(prepared)
        maintenance = !!(await prepared.store.read()).pending
      }
      finally { release() }
      if (maintenance) {
        await evidence?.(stage, 'maintenance')
        app.setPath('userData', previousUserData)
        app.setPath('sessionData', previousSessionData)
        return false
      }
      allowReady?.()
      stage = 'service_start'
      void evidence?.(stage, 'pending')
      connection = await launcher.start(options)
    }
    allowReady?.()
    if (!connection) {
      if (foreground)
        throw new Error('SERVICE_CONNECTION_UNAVAILABLE')
      app.exit(0)
      return true
    }
    let exitCode = 0
    try {
      if (installerExit) {
        await connection.peer.request('service.stop', { expectedServiceInstanceId: connection.discovery.serviceInstanceId, commandId: randomUUID(), reason: 'maintenance' })
        await connection.waitForExit()
      }
      else if (foreground) {
        const processes = { corePid: connection.discovery.process.pid }
        void evidence?.('open_desktop', 'pending', processes)
        const { peer, discovery } = connection
        const outcome = await peer.request('service.openDesktop', { expectedServiceInstanceId: discovery.serviceInstanceId, intent: { kind: 'tasks' } }, 145_000)
          .then(desktopOpenOutcome, (error: unknown) => desktopRequestFailure(error, peer.closed))
        await evidence?.('open_desktop', outcome, processes)
        if (outcome !== 'visible') {
          process.stderr.write(`DESKTOP_OPEN_${outcome.toUpperCase()}\n`)
          exitCode = 1
        }
      }
    }
    finally { connection.peer.close(new Error('SERVICE_LAUNCHER_FINISHED')) }
    app.exit(exitCode)
  }
  catch (error) {
    allowReady?.()
    const code = error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : 'SERVICE_START_FAILED'
    await evidence?.(stage, code === 'SERVICE_START_TIMEOUT' ? 'timeout' : 'failed')
    process.stderr.write(`${code}\n`)
    if (foreground) {
      await app.whenReady()
      if (!(process.platform === 'darwin' && app.getLoginItemSettings().wasOpenedAtLogin) && powerMonitor.getSystemIdleState(1) !== 'locked')
        dialog.showErrorBox('Lexora', `无法启动后台服务。请保留当前数据并重试。\n${code}`)
    }
    app.exit(1)
  }
  return true
}

function desktopRequestFailure(error: unknown, closed: boolean) {
  if (error instanceof RuntimeRequestTimeoutError)
    return 'timeout'
  if (error instanceof RuntimeRemoteError)
    return 'remote_error'
  return closed ? 'channel_closed' : 'request_failed'
}

function desktopOpenOutcome(raw: unknown) {
  const result = desktopOpenResultSchema.safeParse(raw)
  if (!result.success)
    return 'invalid_reply'
  const { accepted, uiReady, targetVisible, visible, focused, reason } = result.data
  if (!accepted)
    return uiReady || targetVisible || visible || focused ? 'invalid_reply' : reason === 'locked' ? 'locked' : 'refused'
  if (reason)
    return 'invalid_reply'
  if (!visible)
    return 'hidden'
  if (!uiReady)
    return 'ui_not_ready'
  return targetVisible ? 'visible' : 'target_not_visible'
}
