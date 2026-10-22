import type { LocalArtifact } from '@buddy-shared/artifacts/artifactApi'
import type { ArtifactAction, ArtifactActionsOptions } from '../../state/artifacts/createArtifactActions'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { createInjectionState } from '@vueuse/core'
import { useMessage } from 'naive-ui'
import { onScopeDispose } from 'vue'
import { translateBuddy } from '@/i18n/buddyI18n'
import { createArtifactActions } from '../../state/artifacts/createArtifactActions'

const [useProvideArtifactActions, injectArtifactActions] = createInjectionState((options: ArtifactActionsOptions & { language: () => BuddyLocale }) => {
  const actions = createArtifactActions(options)
  const message = useMessage()
  let disposed = false
  onScopeDispose(() => disposed = true)
  return {
    ...actions,
    async execute(action: ArtifactAction, artifact: LocalArtifact) {
      const task = options.task()
      const draftId = task?.workspace.composer.draftId.value
      try {
        await actions.execute(action, artifact)
      }
      catch {
        if (!disposed && task === options.task() && draftId === task?.workspace.composer.draftId.value)
          message.error(translateBuddy(options.language(), `desktop.artifacts.${action}Failed`))
      }
    },
  }
})

export { useProvideArtifactActions }
export function useArtifactActions() {
  return injectArtifactActions()
}
