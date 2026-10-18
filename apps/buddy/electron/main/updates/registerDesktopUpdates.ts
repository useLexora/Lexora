import type { DesktopRuntimeHost } from '../app/DesktopRuntimeHost'
import type { DesktopWindowHost } from '../app/DesktopWindowHost'
import type { DesktopEnvironment } from '../app/typing'
import { readFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { app, ipcMain, shell } from 'electron'
import { resolveBuddyProcessControl } from '../../../platform/native/nativeHost'
import { runsRpc } from '../../../shared/runs/runApi'
import { DESKTOP_IPC_CHANNELS } from '../../shared/desktopApi'
import { compareDesktopVersions, desktopUpdateActionSchema, desktopUpdateTargetSchema } from '../../shared/desktopUpdates'
import { checkForDesktopUpdate } from '../desktopUpdateService'
import { assertTrustedSender } from '../ipc'
import { DesktopUpdateCache } from './DesktopUpdateCache'
import { DesktopUpdateDelivery } from './DesktopUpdateDelivery'
import { readDesktopUpdateFailure } from './DesktopUpdateFailure'
import { DesktopUpdatePolicy, readDesktopDistribution } from './DesktopUpdatePolicy'
import { DesktopUpdates } from './DesktopUpdates'
import { DesktopUpdateStore } from './DesktopUpdateStore'
import { isLinuxPackageFormat, linuxInstallerAvailable, linuxManualInstallation, prepareLinuxInstaller, readLinuxInstallationFailure } from './linuxInstaller'
import { MacUpdateInstaller } from './MacUpdateInstaller'
import { launchWindowsUpdateInstaller } from './windowsInstaller'

export function registerDesktopUpdates(environment: DesktopEnvironment, runtime: DesktopRuntimeHost, windows: DesktopWindowHost, requestInstall: (prepare: () => Promise<(() => void) | void>) => Promise<boolean>) {
  let activityRevision = 0
  let revision = 0
  let automaticDownload = runtime.config?.desktop.autoDownloadUpdates ?? true
  const automaticCheck = app.isPackaged && environment.paths.profile !== 'development' && !environment.isSmokeTest
  const metadata = app.isPackaged && environment.paths.profile !== 'development' ? JSON.parse(readFileSync(join(app.getAppPath(), 'package.json'), 'utf8')) : null
  const policy = new DesktopUpdatePolicy(readDesktopDistribution(metadata?.desktopDistribution, process.platform, process.arch))
  const directory = policy.capabilities.download ? join(environment.paths.lexoraHome, 'cache', 'updates') : null
  const downloadDirectory = directory ? join(directory, 'pending') : null
  const linuxFormat = policy.distribution?.format
  const linuxHelper = process.platform === 'linux' && app.isPackaged ? resolveBuddyProcessControl({ appPath: app.getAppPath(), isPackaged: true, resourcesPath: process.resourcesPath }) : undefined
  if (isLinuxPackageFormat(linuxFormat) && directory)
    policy.linuxInstallation = { available: linuxInstallerAvailable(linuxHelper, linuxFormat), failedVersion: readLinuxInstallationFailure(directory) }
  const macInstaller = new MacUpdateInstaller(runtime.network.authenticateProxy)
  const installers = {
    nsis: (path: string) => launchWindowsUpdateInstaller(path),
    dmg: (path: string, update: import('./DesktopUpdatePackage').DesktopUpdatePackage) => macInstaller.prepare(path, update, directory!),
  }
  const delivery = new DesktopUpdateDelivery({
    directory,
    cache: directory ? new DesktopUpdateCache(directory, policy, app.getVersion()) : undefined,
    get: runtime.network.download,
    requestInstall,
    launchInstaller: async (path, update) => {
      const format = policy.distribution?.format
      if (isLinuxPackageFormat(format) && linuxHelper && directory) {
        try {
          return await prepareLinuxInstaller({ helper: linuxHelper, format, directory, path, update, quit: () => app.quit() })
        }
        catch (error) {
          if (!(error instanceof Error && error.message === 'UPDATE_INSTALL_CANCELLED'))
            policy.linuxInstallation.failedVersion = update.version
          throw error
        }
      }
      const installer = format && Object.hasOwn(installers, format) ? installers[format as keyof typeof installers] : null
      if (!installer)
        throw new Error('UPDATE_INSTALL_UNAVAILABLE')
      return installer(path, update)
    },
    openPackage: async (path) => {
      if (await shell.openPath(path))
        throw new Error('UPDATE_PACKAGE_OPEN_FAILED')
    },
    reportFailure: error => environment.diagnostics.record({ scope: 'desktop', component: 'desktop.updates', event: 'update.download.failed', level: 'warn', error, errorCode: readDesktopUpdateFailure(error).code }),
  })
  const service = runtime.service
  const updates = new DesktopUpdates({
    currentVersion: app.getVersion(),
    automatic: automaticCheck,
    enabled: !!runtime.config?.desktop.onboardingCompleted && runtime.config.desktop.updateNotificationsEnabled,
    store: new DesktopUpdateStore(environment.paths.buddyHome),
    check: signal => checkForDesktopUpdate({
      currentVersion: app.getVersion(),
      fetchRelease: runtime.network.get,
      signal,
      onRelease: (release, version) => delivery.discover(compareDesktopVersions(version, app.getVersion()) > 0 || (version === app.getVersion() && version === policy.linuxInstallation.failedVersion) ? policy.resolve(release, version) : { mode: 'release', reason: null, update: null, fallback: null }),
    }),
    canPresent: () => environment.startup.state.status === 'ready' && !!windows.window?.isFocused() && windows.window.isVisible(),
    isIdle: async () => {
      if (service.state.status !== 'ready')
        return false
      const revision = activityRevision
      const busy = runsRpc.isBusy.response.parse(await service.request(runsRpc.isBusy.method, {}, { timeoutMs: 5_000 }))
      return !busy && service.state.status === 'ready' && revision === activityRevision
    },
    reportFailure: () => environment.events.publish({ component: 'desktop.updates', event: 'update.background.failed', level: 'warn', errorCode: 'UPDATE_CHECK_FAILED' }),
  })
  const snapshot = () => ({
    ...updates.state,
    revision,
    delivery: delivery.state,
    downloadDirectory,
    manualInstallation: policy.distribution && delivery.state.version && downloadDirectory && ['ready', 'installing'].includes(delivery.state.status)
      ? linuxManualInstallation(policy.distribution, delivery.state.version, downloadDirectory)
      : undefined,
  })
  const publish = () => {
    revision++
    const window = windows.window
    if (window && !window.isDestroyed())
      window.webContents.send(DESKTOP_IPC_CHANNELS.appUpdatesChanged, snapshot())
  }
  const reconcile = () => delivery.reconcile(updates.state.enabled && updates.state.notification?.revision === delivery.state.version, automaticDownload && !environment.isSmokeTest && environment.paths.profile !== 'test')
  const changes = updates.onDidChange(() => {
    reconcile()
    publish()
  })
  const downloadChanges = delivery.onDidChange(() => {
    reconcile()
    publish()
  })
  const config = runtime.configStore.onDidChange((change) => {
    if (change.kind === 'committed') {
      automaticDownload = change.config.desktop.autoDownloadUpdates
      updates.setEnabled(change.config.desktop.onboardingCompleted && change.config.desktop.updateNotificationsEnabled)
      reconcile()
    }
  })
  const stopRuntime = service.onStateChange(() => {
    activityRevision++
  })
  const stopEvents = service.onNotification(({ method }) => {
    if (method === 'run.event')
      activityRevision++
  })
  const stopStartup = environment.startup.onStateChange(state => updates.setReady(state.status === 'ready'))
  updates.setReady(environment.startup.state.status === 'ready')
  const initialization = updates.start().then(() => delivery.restore(updates.state.result?.status === 'update_available' ? updates.state.result.latestVersion : policy.linuxInstallation.failedVersion === app.getVersion() ? app.getVersion() : null))
  const channels: string[] = [DESKTOP_IPC_CHANNELS.appUpdatesState, DESKTOP_IPC_CHANNELS.appUpdatesAcknowledge, DESKTOP_IPC_CHANNELS.appUpdatesTakeReminder]
  ipcMain.handle(channels[0]!, async (event) => {
    assertTrustedSender(event, windows.window)
    await initialization
    return snapshot()
  })
  ipcMain.handle(channels[1]!, async (event, input: unknown) => {
    assertTrustedSender(event, windows.window)
    const action = desktopUpdateActionSchema.parse(input)
    const ignoredVersion = updates.state.ignoredVersion
    await updates.acknowledge(action)
    if (action.action === 'ignore' && updates.state.ignoredVersion === action.version && delivery.state.version === action.version)
      delivery.cancel()
    if (action.action === 'unignore' && ignoredVersion === action.version && updates.state.ignoredVersion === null) {
      delivery.resumeAutomaticDownload(action.version)
      reconcile()
    }
    return snapshot()
  })
  ipcMain.handle(channels[2]!, (event) => {
    assertTrustedSender(event, windows.window)
    return updates.takeReminder()
  })
  const register = (channel: string, operation: (input: unknown) => unknown) => {
    channels.push(channel)
    ipcMain.handle(channel, (event, input: unknown) => {
      assertTrustedSender(event, windows.window)
      return operation(input)
    })
  }
  const assertTarget = (input: unknown) => {
    const { version } = desktopUpdateTargetSchema.parse(input)
    if (version !== delivery.state.version || version !== updates.state.result?.latestVersion)
      throw new Error('UPDATE_TARGET_CHANGED')
  }
  register(DESKTOP_IPC_CHANNELS.appUpdatesDownload, (input) => {
    assertTarget(input)
    return delivery.download().catch((error: unknown) => {
      environment.diagnostics.record({ scope: 'desktop', component: 'desktop.updates', event: 'update.download.failed', level: 'warn', error, errorCode: readDesktopUpdateFailure(error).code })
      throw error
    })
  })
  register(DESKTOP_IPC_CHANNELS.appUpdatesCancelDownload, (input) => {
    assertTarget(input)
    delivery.cancel()
  })
  register(DESKTOP_IPC_CHANNELS.appUpdatesInstall, (input) => {
    assertTarget(input)
    return delivery.install()
  })
  register(DESKTOP_IPC_CHANNELS.appUpdatesOpenPackage, (input) => {
    assertTarget(input)
    return delivery.openPackage()
  })
  register(DESKTOP_IPC_CHANNELS.appUpdatesCacheSummary, () => delivery.cacheSummary())
  register(DESKTOP_IPC_CHANNELS.appUpdatesClearCache, () => delivery.clearCache())
  register(DESKTOP_IPC_CHANNELS.appUpdatesOpenDirectory, async () => {
    if (!downloadDirectory)
      throw new Error('UPDATE_DOWNLOAD_UNAVAILABLE')
    await mkdir(downloadDirectory, { recursive: true })
    if (await shell.openPath(downloadDirectory))
      throw new Error('DIRECTORY_OPEN_FAILED')
  })
  void initialization.catch(() => environment.events.publish({ component: 'desktop.updates', event: 'update.restore.failed', level: 'warn', errorCode: 'UPDATE_STATE_UNAVAILABLE' }))
  return {
    check: () => updates.check(),
    capabilities: { ...policy.capabilities, automaticCheck },
    async dispose() {
      stopStartup()
      stopEvents()
      stopRuntime()
      config.dispose()
      changes.dispose()
      downloadChanges.dispose()
      for (const channel of channels)
        ipcMain.removeHandler(channel)
      await delivery.dispose()
      await updates.dispose()
    },
  }
}
