import type { DesktopRuntimeHost } from '../app/DesktopRuntimeHost'
import type { DesktopWindowHost } from '../app/DesktopWindowHost'
import type { DesktopEnvironment } from '../app/typing'
import { app, ipcMain } from 'electron'
import { runsRpc } from '../../../shared/runs/runApi'
import { DESKTOP_IPC_CHANNELS } from '../../shared/desktopApi'
import { desktopUpdateActionSchema } from '../../shared/desktopUpdates'
import { checkForDesktopUpdate } from '../desktopUpdateService'
import { assertTrustedSender } from '../ipc'
import { DesktopUpdates } from './DesktopUpdates'
import { DesktopUpdateStore } from './DesktopUpdateStore'

export function registerDesktopUpdates(environment: DesktopEnvironment, runtime: DesktopRuntimeHost, windows: DesktopWindowHost) {
  let activityRevision = 0
  const service = runtime.service
  const updates = new DesktopUpdates({
    currentVersion: app.getVersion(),
    automatic: app.isPackaged && environment.paths.profile !== 'development' && !environment.isSmokeTest,
    enabled: runtime.config?.desktop.updateNotificationsEnabled ?? true,
    store: new DesktopUpdateStore(environment.paths.buddyHome),
    check: signal => checkForDesktopUpdate({ currentVersion: app.getVersion(), fetchRelease: runtime.network.get, signal }),
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
  const changes = updates.onDidChange((state) => {
    const window = windows.window
    if (window && !window.isDestroyed())
      window.webContents.send(DESKTOP_IPC_CHANNELS.appUpdatesChanged, state)
  })
  const config = runtime.configStore.onDidChange((change) => {
    if (change.kind === 'committed')
      updates.setEnabled(change.config.desktop.updateNotificationsEnabled)
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
  const channels = [DESKTOP_IPC_CHANNELS.appUpdatesState, DESKTOP_IPC_CHANNELS.appUpdatesAcknowledge, DESKTOP_IPC_CHANNELS.appUpdatesTakeReminder]
  ipcMain.handle(channels[0]!, async (event) => {
    assertTrustedSender(event, windows.window)
    await updates.start()
    return updates.state
  })
  ipcMain.handle(channels[1]!, (event, input: unknown) => {
    assertTrustedSender(event, windows.window)
    return updates.acknowledge(desktopUpdateActionSchema.parse(input))
  })
  ipcMain.handle(channels[2]!, (event) => {
    assertTrustedSender(event, windows.window)
    return updates.takeReminder()
  })
  void updates.start().catch(() => environment.events.publish({ component: 'desktop.updates', event: 'update.restore.failed', level: 'warn', errorCode: 'UPDATE_STATE_UNAVAILABLE' }))
  return {
    check: () => updates.check(),
    async dispose() {
      stopStartup()
      stopEvents()
      stopRuntime()
      config.dispose()
      changes.dispose()
      for (const channel of channels)
        ipcMain.removeHandler(channel)
      await updates.dispose()
    },
  }
}
