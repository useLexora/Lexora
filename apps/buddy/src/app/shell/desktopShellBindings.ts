import type { DesktopAppInfo, DesktopUserProfileConfig } from '@buddy-electron/shared/desktopApi'
import type { Ref } from 'vue'
import type { useDesktopLifecycle } from '../bootstrap/useDesktopLifecycle'
import type { DesktopNavigation } from '../bootstrap/useDesktopNavigation'
import type { NotificationCenterStore } from '@/modules/notifications'
import type { ShortcutSettings } from '@/modules/settings/contracts'
import type { TaskChatWorkspace, TaskIndex, TaskResourcePanel } from '@/modules/tasks/contracts'

export interface DesktopShellBindings {
  appInfo: Readonly<Ref<DesktopAppInfo | null>>
  contextPanelGlobal: Readonly<Ref<boolean>>
  extensionNavigation: Readonly<Ref<Array<{ id: string, title: string, iconUrl?: string }>>>
  lifecycle: ReturnType<typeof useDesktopLifecycle>
  navigation: Pick<DesktopNavigation, 'navigate' | 'openNotification'>
  notifications: Pick<NotificationCenterStore, 'items' | 'isLoading' | 'unseenCount' | 'load' | 'markAllSeen'>
  profileConfig: Readonly<Ref<DesktopUserProfileConfig>>
  resourceContext: TaskChatWorkspace['context']
  resources: TaskResourcePanel
  shortcuts: ShortcutSettings
  taskIndex: TaskIndex
  toggleAppSidebar: () => void
  updateProfile: (profile: Partial<DesktopUserProfileConfig>) => Promise<boolean>
  workbench: import('../workbench/desktopWorkbenchContext').DesktopWorkbench
}
