import type { Ref } from 'vue'
import type { useExtensionState } from './state/useExtensionState'
import type { useExtensionViews } from './widgets/useExtensionViews'
import { createInjectionState } from '@vueuse/core'

export interface ExtensionContext {
  state: ReturnType<typeof useExtensionState>
  views: ReturnType<typeof useExtensionViews>
  language: Readonly<Ref<string>>
  isDark: Readonly<Ref<boolean>>
  focusView: (id: string) => void
}
const [useProvideExtensionContext, injectExtensionContext] = createInjectionState((context: ExtensionContext) => context)
export { useProvideExtensionContext }
export function useExtensionContext(): ExtensionContext {
  const context = injectExtensionContext()
  if (!context)
    throw new Error('Extension context is unavailable')
  return context
}
