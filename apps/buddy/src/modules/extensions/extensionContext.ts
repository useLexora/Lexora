import type { WorkbenchContextSnapshot } from '@buddy-shared/workbench/workbenchContext'
import type { Ref } from 'vue'
import type { useExtensionState } from './state/useExtensionState'
import type { useExtensionUiContributions } from './state/useExtensionUiContributions'
import type { useExtensionViews } from './widgets/useExtensionViews'
import type { WorkbenchAnchors } from '@/shared/ui/contributions/workbenchUiContext'
import { createInjectionState } from '@vueuse/core'

export interface ExtensionContext {
  workbench: Readonly<Ref<WorkbenchContextSnapshot>>
  anchors: WorkbenchAnchors
  ui: ReturnType<typeof useExtensionUiContributions>
  state: ReturnType<typeof useExtensionState>
  views: ReturnType<typeof useExtensionViews>
  language: Readonly<Ref<string>>
  isDark: Readonly<Ref<boolean>>
  endInteraction: (id: string) => void
  focusView: (id: string) => void
  startCreation: (prompt: string) => Promise<void>
}
const [useProvideExtensionContext, injectExtensionContext] = createInjectionState((context: ExtensionContext) => context)
export { useProvideExtensionContext }
export function useExtensionContext(): ExtensionContext {
  const context = injectExtensionContext()
  if (!context)
    throw new Error('Extension context is unavailable')
  return context
}
