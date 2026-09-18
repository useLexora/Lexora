import type { LexoraDesktopApi } from '@buddy-electron/shared/desktopApi'
import type { Ref } from 'vue'
import type { TaskCapability, TaskResourcePanel } from './contracts'
import type { DesktopBrowserGuestSurfaceHost } from '@/platform/browser/browserGuestSurface'
import { createInjectionState } from '@vueuse/core'

export interface TaskEnvironment {
  browser: LexoraDesktopApi['browser']
  browserGuests: DesktopBrowserGuestSurfaceHost
  clipboard: LexoraDesktopApi['clipboard']
  notificationTarget: Readonly<Ref<{ conversationId: string, messageId: string } | null>>
  resources: TaskResourcePanel
}

export interface TaskContext extends Omit<TaskEnvironment, 'notificationTarget'> {
  startTask?: (spaceId?: string | null) => Promise<void>
  notificationTargetMessageId: Readonly<Ref<string | null>>
  tasks: TaskCapability
}

const [useProvideTaskEnvironment, injectTaskEnvironment] = createInjectionState((context: TaskEnvironment) => context)
export { useProvideTaskEnvironment }
export function useTaskEnvironment(): TaskEnvironment {
  const context = injectTaskEnvironment()
  if (!context)
    throw new Error('Task environment is unavailable')
  return context
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
