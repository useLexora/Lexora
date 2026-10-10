import type { LocalChatApi } from '@buddy-electron/shared/localChatApi'
import type { LocalSpace } from '@buddy-shared/spaces/spaceApi'
import type { Ref } from 'vue'
import { createInjectionState } from '@vueuse/core'

export interface SkillsContext {
  api: LocalChatApi['skills']
  spaces: Readonly<Ref<readonly LocalSpace[]>>
  ready: Promise<void>
  writeClipboardText: (text: string) => Promise<void>
  startCreation: (spaceId: string | null, prompt: string) => Promise<void>
}

const [useProvideSkillsContext, injectSkillsContext] = createInjectionState(
  (context: SkillsContext) => context,
)

export { useProvideSkillsContext }

export function useSkillsContext(): SkillsContext {
  const context = injectSkillsContext()
  if (!context)
    throw new Error('Skills context is unavailable')
  return context
}
