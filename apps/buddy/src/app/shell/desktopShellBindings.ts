import type { DesktopAppInfo } from '@buddy-electron/shared/desktopApi'
import type { Ref } from 'vue'
import type { useDesktopLifecycle } from '../bootstrap/useDesktopLifecycle'
import type { DesktopNavigation } from '../bootstrap/useDesktopNavigation'
import type { NotificationCenterStore } from '@/modules/notifications'
import type { TaskChatWorkspace, TaskIndex, TaskResourcePanel } from '@/modules/tasks/contracts'

export interface DesktopShellBindings {
  contextPanelGlobal: Readonly<Ref<boolean>>
  resources: TaskResourcePanel
  resourceContext: TaskChatWorkspace['context']
  lifecycle: ReturnType<typeof useDesktopLifecycle>
  appInfo: Readonly<Ref<DesktopAppInfo | null>>
  navigation: Pick<DesktopNavigation, 'navigate' | 'openNotification' | 'openSpace' | 'openTask'>
  notifications: Pick<NotificationCenterStore, 'items' | 'isLoading' | 'unseenCount' | 'load' | 'markAllSeen'>
  taskIndex: Pick<TaskIndex, 'spaces' | 'tasks'>
  toggleAppSidebar: () => void
}
