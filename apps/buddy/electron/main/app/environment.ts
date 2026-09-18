import type { DesktopEnvironment } from './typing'
import { mkdirSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname } from 'node:path'
import process from 'node:process'
import { app, crashReporter, Menu, protocol } from 'electron'
import buddyPackage from '../../../package.json'
import { currentPlatform } from '../../../platform/currentPlatform'
import { resolveBuddyPrivateDirectories } from '../../../platform/native/nativeHost'
import developmentDesktopIconPath from '../../../resources/icons/app-icon-dev.png?asset'
import stableDesktopIconPath from '../../../resources/icons/app-icon.png?asset'
import developmentTrayIconPath from '../../../resources/icons/tray-icon-dev.png?asset'
import { readDiagnosticError } from '../../../shared/diagnostics/applicationDiagnostic'
import { ApplicationEvents } from '../../../shared/observability/ApplicationEvents'
import { OPERATING_SYSTEM } from '../../../shared/platform/identifiers'
import { attachmentSchemePrivileges } from '../attachmentProtocol'
import { DesktopDiagnosticLogger } from '../desktopDiagnostics'
import { extensionSchemePrivileges } from '../extensions/ExtensionProtocol'
import { resolveBuddyRuntimePaths } from '../paths'
import { desktopHosts } from '../platform/desktopHost'
import { rendererSchemePrivileges } from '../rendererProtocol'
import { resolveDesktopLaunchIntent } from '../startupIntent'
import { bootstrapStep } from './desktopBootstrap'
import { DesktopStartup } from './DesktopStartup'
import { checkDesktopDirectories, criticalDesktopDirectories } from './desktopStorage'

export function prepareDesktopEnvironment(): DesktopEnvironment {
  const desktopHost = desktopHosts[currentPlatform.id]
  const isSmokeTest = process.env.LEXORA_DESKTOP_SMOKE_TEST === '1'
  const paths = bootstrapStep('resolve_paths', () => resolveBuddyRuntimePaths({
    defaultUserData: app.getPath('userData'),
    desktopName: buddyPackage.desktopName,
    isPackaged: app.isPackaged,
    localAppData: process.env.LOCALAPPDATA,
    lexoraHomeOverride: process.env.LEXORA_HOME,
    nativePetSocketOverride: process.env.LEXORA_BUDDY_PET_SOCKET,
    nativePetStateOverride: process.env.LEXORA_BUDDY_PET_STATE_PATH,
    profileOverride: process.env.LEXORA_BUDDY_PROFILE,
    smokeTest: isSmokeTest,
    temporaryDirectory: tmpdir(),
    userDataOverride: app.commandLine.hasSwitch('user-data-dir')
      ? app.commandLine.getSwitchValue('user-data-dir')
      : undefined,
    userHome: homedir(),
    userId: process.geteuid?.() ?? 0,
    xdgCacheHome: process.env.XDG_CACHE_HOME,
    xdgConfigHome: process.env.XDG_CONFIG_HOME,
    xdgRuntimeDirectory: process.env.XDG_RUNTIME_DIR,
    xdgStateHome: process.env.XDG_STATE_HOME,
  }))
  const diagnostics = new DesktopDiagnosticLogger({
    directory: paths.logs,
    appVersion: app.getVersion(),
    userHome: homedir(),
  })
  const events = new ApplicationEvents()
  const startup = new DesktopStartup(events)
  events.subscribe(event => diagnostics.record({ ...event, scope: 'desktop' }))
  events.subscribe(startup.observe)
  return {
    diagnostics,
    events,
    startup,
    desktopIconPath: paths.iconVariant === 'development' ? developmentDesktopIconPath : stableDesktopIconPath,
    initialLaunchIntent: resolveDesktopLaunchIntent(process.argv, currentPlatform.id === OPERATING_SYSTEM.MacOS && app.getLoginItemSettings().wasOpenedAtLogin),
    isSmokeTest,
    paths,
    windowStateAvailable: true,
    setAutostart: desktopHost.setAutostart,
    trayIconPath: paths.iconVariant === 'development' ? developmentTrayIconPath : stableDesktopIconPath,
  }
}

export function initializeDesktopEnvironment(environment: DesktopEnvironment): void {
  const { paths } = environment
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
  bootstrapStep('register_protocols', () => {
    protocol.registerSchemesAsPrivileged([...attachmentSchemePrivileges, rendererSchemePrivileges, extensionSchemePrivileges])
  })
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
    await checkDesktopDirectories({ window_state: dirname(paths.windowState) }, privateDirectoriesExecutable())
    environment.windowStateAvailable = true
  }
  catch (error) {
    environment.windowStateAvailable = false
    environment.diagnostics.record({ scope: 'desktop', level: 'warn', event: 'window_state.unavailable', ...readDiagnosticError(error) })
  }
  app.setAppUserModelId(paths.desktopName)
  Menu.setApplicationMenu(null)
}
