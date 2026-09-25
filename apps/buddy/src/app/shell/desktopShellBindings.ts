import type { DesktopAppInfo, DesktopUserProfileConfig } from '@buddy-electron/shared/desktopApi'
import type { Ref } from 'vue'
import type { useDesktopLifecycle } from '../bootstrap/useDesktopLifecycle'
import type { DesktopNavigation } from '../bootstrap/useDesktopNavigation'
import type { NotificationCenterStore } from '@/modules/notifications'
import type { ShortcutSettings } from '@/modules/settings/contracts'
import type { TaskChatWorkspace, TaskIndex, TaskResourcePanel } from '@/modules/tasks/contracts'
import type { DesktopNavigationEntry } from '@/shared/navigation/desktopPages'

export interface DesktopShellBindings {
  appInfo: Readonly<Ref<DesktopAppInfo | null>>
  contextPanelGlobal: Readonly<Ref<boolean>>
  pages: { current: Readonly<Ref<string>>, navigation: Readonly<Ref<DesktopNavigationEntry[]>> }
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
