import type { LocalSpace } from '@buddy-shared/spaces/spaceApi'

import type { Ref } from 'vue'
import type { AutomationCapability } from './state/typing'
import type { ModelProvidersStore } from '@/modules/models'
import { createInjectionState } from '@vueuse/core'

export interface AutomationContext {
  automations: AutomationCapability
  openTask: (conversationId: string) => Promise<void>
  onTaskDeleted: (conversationId: string) => void
  beforeTaskDelete: (conversationId: string) => Promise<boolean>
  providerSettings: Pick<ModelProvidersStore, 'models' | 'providers'>
  ready: Promise<void>
  refreshTasks: () => Promise<void>
  spaces: Readonly<Ref<ReadonlyArray<LocalSpace>>>
}

const [useProvideAutomationContext, injectAutomationContext] = createInjectionState(
  (context: AutomationContext) => context,
)

export { useProvideAutomationContext }

export function useAutomationContext(): AutomationContext {
  const context = injectAutomationContext()
  if (!context)
    throw new Error('Automation context is unavailable')
  return context
}
