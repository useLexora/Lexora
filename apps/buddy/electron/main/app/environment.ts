import type { DesktopEnvironment } from './typing'
import { mkdirSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import process from 'node:process'
import { app, crashReporter, Menu } from 'electron'
import { currentPlatform } from '../../../platform/currentPlatform'
import { resolveBuddyPrivateDirectories } from '../../../platform/native/nativeHost'
import { acquireStorageRootLease } from '../../../platform/storage/StorageRootLease'
import { readDiagnosticError } from '../../../shared/diagnostics/applicationDiagnostic'
import { ApplicationEvents } from '../../../shared/observability/ApplicationEvents'
import { OPERATING_SYSTEM } from '../../../shared/platform/identifiers'
import { DesktopDiagnosticLogger } from '../desktopDiagnostics'
import { desktopHosts } from '../platform/desktopHost'
import { resolveDesktopLaunchIntent } from '../startupIntent'
import { requestPersistenceUpgrade } from '../storage/requestPersistenceUpgrade'
import { prepareStorageBootstrap, readStorageBootstrap, unifiedStoragePaths } from '../storage/storageBootstrap'
import { bootstrapStep } from './desktopBootstrap'
import { desktopIcons } from './desktopIcons'
import { resolveDesktopRuntimePaths } from './desktopRuntimePaths'
import { DesktopStartup } from './DesktopStartup'
import { checkDesktopDirectories, criticalDesktopDirectories, DesktopInstanceLockUnavailable, prepareDesktopPrivateStorage } from './desktopStorage'
import { observeStartupDiagnostics } from './startupDiagnostics'
import { bindWindowsChromiumSession } from './windowsChromiumSession'

export async function prepareDesktopEnvironment(platformHost?: DesktopEnvironment['platformHost']): Promise<DesktopEnvironment> {
  if (currentPlatform.id === OPERATING_SYSTEM.Linux)
    app.commandLine.appendSwitch('enable-speech-dispatcher')
  const desktopHost = desktopHosts[currentPlatform.id]
  const isSmokeTest = process.env.LEXORA_DESKTOP_SMOKE_TEST === '1'
  const legacyPaths = bootstrapStep('resolve_paths', resolveDesktopRuntimePaths)
  const { bootstrapRoot, state } = readStorageBootstrap(legacyPaths.lexoraHome)
  if (platformHost && (platformHost.peer.closed || !state.identity || state.pending || relative(realpathSync(state.activeRoot), realpathSync(platformHost.bootstrap.profileRoot)) !== '' || legacyPaths.profile !== platformHost.bootstrap.profile))
    throw new Error('PLATFORM_HOST_PROFILE_CHANGED')
  prepareDesktopPrivateStorage(bootstrapRoot, privateDirectoriesExecutable())
  mkdirSync(join(bootstrapRoot, 'migration-session'), { recursive: true, mode: 0o700 })
  app.setPath('sessionData', join(bootstrapRoot, 'migration-session'))
  app.setName(legacyPaths.appName)
  prepareDesktopPrivateStorage(legacyPaths.userData, privateDirectoriesExecutable())
  app.setPath('userData', legacyPaths.userData)
  if (!app.requestSingleInstanceLock({ executablePath: process.execPath }))
    throw new DesktopInstanceLockUnavailable(legacyPaths.userData)
  const storage = prepareStorageBootstrap(legacyPaths, privateDirectoriesExecutable())
  if (platformHost) {
    if (platformHost.peer.closed || storage.state.pending || relative(realpathSync(storage.state.activeRoot), realpathSync(platformHost.bootstrap.profileRoot)) !== '' || legacyPaths.profile !== platformHost.bootstrap.profile)
      throw new Error('PLATFORM_HOST_PROFILE_CHANGED')
  }
  else if (!storage.state.pending) {
    const releaseStorage = acquireStorageRootLease(storage.state.activeRoot, storage.leaseDirectory, storage.privateDirectoriesExecutable)
    try {
      if (!process.argv.includes('--lexora-storage-maintenance') && process.env.LEXORA_BUDDY_STORAGE_AUTHORITY === 'sqlite') {
        await requestPersistenceUpgrade(storage)
        storage.state = await storage.store.read()
      }
    }
    catch (error) {
      releaseStorage()
      throw error
    }
    if (storage.state.pending)
      releaseStorage()
    else
      app.once('will-quit', releaseStorage)
  }
  const paths = unifiedStoragePaths(legacyPaths, storage.state.activeRoot)
  if (process.env.LEXORA_BUDDY_PET_STATE_PATH)
    paths.nativePetState = legacyPaths.nativePetState
  if (currentPlatform.id === OPERATING_SYSTEM.Windows && !storage.state.pending && !process.argv.includes('--lexora-storage-maintenance'))
    bindWindowsChromiumSession(legacyPaths, paths, privateDirectoriesExecutable())
  if (app.commandLine.hasSwitch('user-data-dir'))
    paths.userData = legacyPaths.userData
  const diagnostics = new DesktopDiagnosticLogger({
    directory: storage.state.pending ? join(bootstrapRoot, 'logs') : paths.logs,
    appVersion: app.getVersion(),
    userHome: homedir(),
  })
  const events = new ApplicationEvents()
  const startup = new DesktopStartup(() => events.publish({ event: 'observer.failed', component: 'startup', level: 'warn' }))
  events.subscribe(event => diagnostics.record({ ...event, scope: 'desktop' }))
  observeStartupDiagnostics(startup, events)
  return {
    ...(platformHost ? { platformHost } : {}),
    diagnostics,
    events,
    startup,
    desktopIconPath: desktopIcons[paths.profile].app,
    initialLaunchIntent: resolveDesktopLaunchIntent(process.argv, currentPlatform.id === OPERATING_SYSTEM.MacOS && app.getLoginItemSettings().wasOpenedAtLogin),
    isSmokeTest,
    paths,
    storage,
    windowStateAvailable: true,
    setAutostart: desktopHost.setAutostart,
    trayIconPath: desktopIcons[paths.profile].tray,
  }
}

export function initializeDesktopEnvironment(environment: DesktopEnvironment): void {
  const { paths } = environment
  prepareDesktopPrivateStorage(paths.lexoraHome, privateDirectoriesExecutable())
  const directories = {
    session_data: paths.sessionData,
    user_data: paths.userData,
  } as const
  for (const [role, directory] of Object.entries(directories)) {
    bootstrapStep('create_directory', () => mkdirSync(directory, { mode: 0o700, recursive: true }), role as keyof typeof directories)
  }
  let crashDumpsAvailable = false
  try {
    bootstrapStep('create_directory', () => mkdirSync(paths.crashDumps, { mode: 0o700, recursive: true }), 'crash_dumps')
    bootstrapStep('configure_paths', () => app.setPath('crashDumps', paths.crashDumps), 'crash_dumps')
    crashDumpsAvailable = true
  }
  catch (error) {
    environment.diagnostics.record({ scope: 'desktop', level: 'warn', event: 'crash_reporter.unavailable', ...readDiagnosticError(error) })
  }
  if (currentPlatform.id === OPERATING_SYSTEM.Windows && relative(realpathSync(app.getPath('sessionData')), realpathSync(paths.sessionData)) !== '')
    throw new Error('DESKTOP_SESSION_PROFILE_CHANGED')
  bootstrapStep('configure_paths', () => {
    app.setName(paths.appName)
    app.setPath('userData', paths.userData)
    app.setPath('sessionData', paths.sessionData)
    app.setAppLogsPath(paths.logs)
  })
  if (crashDumpsAvailable) {
    try {
      bootstrapStep('crash_reporter', () => crashReporter.start({ productName: paths.appName, uploadToServer: false }))
    }
    catch (error) {
      environment.diagnostics.record({ scope: 'desktop', level: 'warn', event: 'crash_reporter.unavailable', ...readDiagnosticError(error) })
    }
  }
  bootstrapStep('desktop_identity', () => desktopHosts[currentPlatform.id].setIdentity?.(paths.desktopName))
}

function privateDirectoriesExecutable(): string | undefined {
  return resolveBuddyPrivateDirectories({
    appPath: app.getAppPath(),
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
  })
}

export function checkDesktopCoreDirectories(environment: DesktopEnvironment): Promise<void> {
  return checkDesktopDirectories(criticalDesktopDirectories(environment.paths), privateDirectoriesExecutable())
}

export async function prepareDesktopReady(environment: DesktopEnvironment): Promise<void> {
  const { paths } = environment
  await checkDesktopCoreDirectories(environment)
  try {
    await checkDesktopDirectories({ window_state: dirname(paths.windowState) })
    environment.windowStateAvailable = true
  }
  catch (error) {
    environment.windowStateAvailable = false
    environment.diagnostics.record({ scope: 'desktop', level: 'warn', event: 'window_state.unavailable', ...readDiagnosticError(error) })
  }
  app.setAppUserModelId(paths.desktopName)
  Menu.setApplicationMenu(null)
}
