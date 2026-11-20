import type { LocalNotificationList } from '../../../shared/notifications/notificationApi'
import type { DeviceNotificationList } from '../../shared/desktopNotifications'
import type { LocalChatIpcContext } from './registrar'
import { notificationsRequestSchemas, notificationsRpc } from '../../../shared/notifications/notificationApi'
import { compareNotifications, deviceNotificationPrefix } from '../../shared/desktopNotifications'
import { LOCAL_CHAT_IPC_CHANNELS } from '../../shared/localChatApi'

export function registerNotificationCenterIpc({ handle, request, options }: LocalChatIpcContext) {
  const inbox = options.notificationInbox
  async function snapshot(local: Promise<LocalNotificationList>, published = inbox?.list()): Promise<DeviceNotificationList> {
    const [runtime, entries = []] = await Promise.all([local, published])
    return {
      items: [...runtime.items, ...entries].sort(compareNotifications),
      unseenCount: runtime.unseenCount + entries.filter(item => item.attention === 'unseen').length,
    }
  }

  handle(LOCAL_CHAT_IPC_CHANNELS.notificationsList, () => snapshot(request(notificationsRpc.list, {})))
  handle(LOCAL_CHAT_IPC_CHANNELS.notificationsMarkSeen, (_event, input) => {
    const target = notificationsRequestSchemas.notificationRevision.parse(input)
    return target.notificationId.startsWith(deviceNotificationPrefix)
      ? snapshot(request(notificationsRpc.list, {}), inbox?.markSeen(target))
      : snapshot(request(notificationsRpc.markSeen, target))
  })
  handle(LOCAL_CHAT_IPC_CHANNELS.notificationsMarkAllSeen, () => snapshot(request(notificationsRpc.markAllSeen, {}), inbox?.markAllSeen()))
}
