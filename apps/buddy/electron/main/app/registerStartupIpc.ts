import type { BrowserWindow } from 'electron'
import type { DesktopStartup } from './DesktopStartup'
import { ipcMain } from 'electron'
import { rendererLifecycleReportSchema } from '../../../shared/lifecycle/serviceLifecycle'
import { DESKTOP_IPC_CHANNELS } from '../../shared/desktopApi'
import { assertTrustedSender } from '../ipc'

export function registerStartupIpc(startup: DesktopStartup, getWindow: () => BrowserWindow | null): () => void {
  ipcMain.handle(DESKTOP_IPC_CHANNELS.appStartupGetState, (event) => {
    assertTrustedSender(event, getWindow())
    return startup.reconcile()
  })
  ipcMain.handle(DESKTOP_IPC_CHANNELS.appStartupReport, (event, input: unknown) => {
    assertTrustedSender(event, getWindow())
    const report = rendererLifecycleReportSchema.parse(input)
    if (report.change.snapshot.components.some(component => component.component !== 'renderer' && !component.component.startsWith('renderer.')))
      throw new Error('Invalid renderer startup stage')
    startup.acceptRenderer(report)
  })
  const stop = startup.onStateChange((state) => {
    const contents = getWindow()?.webContents
    if (contents && !contents.isDestroyed())
      contents.send(DESKTOP_IPC_CHANNELS.appStartupStateChanged, state)
  })
  return () => {
    stop()
    ipcMain.removeHandler(DESKTOP_IPC_CHANNELS.appStartupGetState)
    ipcMain.removeHandler(DESKTOP_IPC_CHANNELS.appStartupReport)
  }
}
