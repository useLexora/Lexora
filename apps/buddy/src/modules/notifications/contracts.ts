import type { DesktopUpdateNotification } from '@buddy-electron/shared/desktopUpdates'
import type { LocalNotification } from '@buddy-shared/notifications/notificationApi'

export type DesktopNotification = LocalNotification | DesktopUpdateNotification
