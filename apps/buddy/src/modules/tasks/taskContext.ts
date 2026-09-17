import type { LexoraDesktopApi } from '@buddy-electron/shared/desktopApi'
import type { Ref } from 'vue'
import type { TaskCapability, TaskResourcePanel } from './contracts'
import type { DesktopBrowserGuestSurfaceHost } from '@/platform/browser/browserGuestSurface'
import { createInjectionState } from '@vueuse/core'

export interface TaskContext {
  browser: LexoraDesktopApi['browser']
  browserGuests: DesktopBrowserGuestSurfaceHost
  clipboard: LexoraDesktopApi['clipboard']
  notificationTargetMessageId: Readonly<Ref<string | null>>
  tasks: TaskCapability
  resources: TaskResourcePanel
}

const [useProvideTaskContext, injectTaskContext] = createInjectionState(
  (context: TaskContext) => context,
)

export { useProvideTaskContext }

export function useTaskContext(): TaskContext {
  const context = injectTaskContext()
  if (!context)
    throw new Error('Task context is unavailable')
  return context
}
