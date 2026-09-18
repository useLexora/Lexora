import type { Ref } from 'vue'
import type { TaskSpaceInput } from './typing'
import type { TaskIndexController } from './useTaskIndex'
import { computed, onScopeDispose, readonly, watch } from 'vue'

interface UseTaskSpacesOptions {
  index: TaskIndexController
  activateDraftScope: (spaceId: string | null) => void
  draftId: Readonly<Ref<string>>
  onError: (error: unknown) => void
  persistWorkspaceState: () => Promise<boolean>
  spaceId: Readonly<Ref<string | null>>
  selectDefaultModel: () => void
}

export function useTaskSpaces(options: UseTaskSpacesOptions) {
  const activeSpace = computed(() => options.index.data.spaces.value.find(space => space.id === options.spaceId.value) ?? null)
  let scopeVersion = 0
  let disposed = false
  watch([options.draftId, options.spaceId], () => scopeVersion++, { flush: 'sync' })
  onScopeDispose(() => {
    disposed = true
    scopeVersion++
  })

  async function activateSpaceDraft(spaceId: string) {
    const space = options.index.data.spaces.value.find(item => item.id === spaceId && item.revokedAt === null)
    if (!space)
      return
    options.activateDraftScope(space.id)
    options.selectDefaultModel()
    const current = scopeVersion
    try {
      await options.persistWorkspaceState()
    }
    catch (error) {
      if (!disposed && current === scopeVersion)
        options.onError(error)
    }
  }

  async function createSpace(input: TaskSpaceInput) {
    const current = scopeVersion
    const space = await options.index.createSpace(input)
    if (space && !disposed && current === scopeVersion)
      await activateSpaceDraft(space.id)
    return !!space
  }

  return { activeSpace: readonly(activeSpace), createSpace, activateSpaceDraft }
}
