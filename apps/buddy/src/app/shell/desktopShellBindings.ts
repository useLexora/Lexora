import type { DesktopAppInfo } from '@buddy-electron/shared/desktopApi'
import type { Ref } from 'vue'
import type { useDesktopLifecycle } from '../bootstrap/useDesktopLifecycle'
import type { DesktopNavigation } from '../bootstrap/useDesktopNavigation'
import type { NotificationCenterStore } from '@/modules/notifications'
import type { ShortcutSettings } from '@/modules/settings/contracts'
import type { TaskChatWorkspace, TaskIndex, TaskResourcePanel } from '@/modules/tasks/contracts'

export interface DesktopShellBindings {
  extensionNavigation: Readonly<Ref<Array<{ id: string, title: string, iconUrl?: string }>>>
  shortcuts: ShortcutSettings
  workbench: import('../workbench/desktopWorkbenchContext').DesktopWorkbench
  contextPanelGlobal: Readonly<Ref<boolean>>
  resources: TaskResourcePanel
  resourceContext: TaskChatWorkspace['context']
  lifecycle: ReturnType<typeof useDesktopLifecycle>
  appInfo: Readonly<Ref<DesktopAppInfo | null>>
  navigation: Pick<DesktopNavigation, 'navigate' | 'openNotification'>
  notifications: Pick<NotificationCenterStore, 'items' | 'isLoading' | 'unseenCount' | 'load' | 'markAllSeen'>
  taskIndex: TaskIndex
  toggleAppSidebar: () => void
}
