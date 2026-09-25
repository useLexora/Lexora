import type { WorkbenchContextSnapshot } from '@buddy-shared/workbench/workbenchContext'
import type { WorkbenchControl } from '@buddy-shared/workbench/workbenchUi'
import type { Ref } from 'vue'
import type { useExtensionState } from './state/useExtensionState'
import type { useExtensionViews } from './widgets/useExtensionViews'
import type { WorkbenchAnchors } from '@/shared/ui/contributions/workbenchUiContext'
import { createInjectionState } from '@vueuse/core'

export interface ExtensionContext {
  workbench: Readonly<Ref<WorkbenchContextSnapshot>>
  anchors: WorkbenchAnchors
  controls: { selection: Readonly<Ref<Record<WorkbenchControl, string>>>, select: (target: WorkbenchControl, id: string) => void }
  state: ReturnType<typeof useExtensionState>
  views: ReturnType<typeof useExtensionViews>
  language: Readonly<Ref<string>>
  isDark: Readonly<Ref<boolean>>
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
