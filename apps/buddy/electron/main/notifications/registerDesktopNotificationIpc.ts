import type { BrowserWindow } from 'electron'
import type { DesktopNotificationService } from '../DesktopNotificationService'
import { ipcMain } from 'electron'
import { DESKTOP_NOTIFICATION_CHANNEL, desktopNotificationRequestSchema, desktopNotificationTestResultSchema } from '../../../shared/notifications/desktopNotification'
import { assertTrustedSender } from '../ipc'

export function registerDesktopNotificationIpc(options: {
  getWindow: () => BrowserWindow | null
  notifications: DesktopNotificationService
}): () => void {
  ipcMain.handle(DESKTOP_NOTIFICATION_CHANNEL, async (event, input: unknown) => {
    assertTrustedSender(event, options.getWindow())
    desktopNotificationRequestSchema.parse(input)
    return desktopNotificationTestResultSchema.parse(await options.notifications.test())
  })
  return () => ipcMain.removeHandler(DESKTOP_NOTIFICATION_CHANNEL)
}
