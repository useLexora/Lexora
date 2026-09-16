import type { LexoraDesktopApi } from '@buddy-electron/shared/desktopApi'
import type { LocalSpace } from '@buddy-shared/spaces/spaceApi'
import type { Ref } from 'vue'

import type { ChatDrafts } from '../drafts/typing'
import type { TaskSpaceInput } from './typing'
import { computed, onScopeDispose, readonly, watch } from 'vue'

interface UseTaskSpacesOptions {
  activateDraftScope: (spaceId: string | null) => void
  api: Pick<LexoraDesktopApi['localChat']['spaces'], 'create' | 'update' | 'delete' | 'selectDirectory' | 'revealFile'>
  drafts: Pick<ChatDrafts, 'discard'>
  draftId: Readonly<Ref<string>>
  applySpace: (space: LocalSpace) => void
  onError: (error: unknown) => void
  persistWorkspaceState: () => Promise<boolean>
  spaceId: Readonly<Ref<string | null>>
  spaces: Readonly<Ref<ReadonlyArray<LocalSpace>>>
  refreshIndex: () => Promise<void>
  selectDefaultModel: () => void
}

export function useTaskSpaces(options: UseTaskSpacesOptions) {
  const activeSpace = computed(() => options.spaces.value.find(
    space => space.id === options.spaceId.value,
  ) ?? null)
  let scopeVersion = 0
  let disposed = false
  watch(options.draftId, () => {
    scopeVersion += 1
  }, { flush: 'sync' })
  onScopeDispose(() => {
    disposed = true
    scopeVersion += 1
  })

  async function activateSpaceDraft(spaceId: string) {
    const space = options.spaces.value.find(
      item => item.id === spaceId && item.revokedAt === null,
    )
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
    let space: LocalSpace
    try {
      space = await options.api.create(input)
    }
    catch (error) {
      if (!disposed && current === scopeVersion)
        options.onError(error)
      return false
    }
    if (disposed)
      return true
    options.applySpace(space)
    try {
      await options.refreshIndex()
    }
    catch (error) {
      if (!disposed && current === scopeVersion)
        options.onError(error)
    }
    if (!disposed && current === scopeVersion)
      await activateSpaceDraft(space.id)
    return true
  }

  async function updateSpace(input: TaskSpaceInput & { spaceId: string }) {
    const current = scopeVersion
    let space: LocalSpace
    try {
      space = await options.api.update(input)
    }
    catch (error) {
      if (!disposed && current === scopeVersion)
        options.onError(error)
      return false
    }
    if (disposed)
      return true
    options.applySpace(space)
    try {
      await options.refreshIndex()
    }
    catch (error) {
      if (!disposed && current === scopeVersion)
        options.onError(error)
    }
    return true
  }

  async function deleteSpace(spaceId: string) {
    try {
      await options.api.delete(spaceId)
      await options.drafts.discard(`space:${spaceId}`)
      if (options.spaceId.value === spaceId)
        options.activateDraftScope(null)
      await options.refreshIndex()
      await options.persistWorkspaceState()
      return true
    }
    catch (error) {
      options.onError(error)
      return false
    }
  }

  async function selectSpaceDirectory(): Promise<string | null> {
    try {
      return await options.api.selectDirectory()
    }
    catch (error) {
      options.onError(error)
      return null
    }
  }

  async function openSpaceDirectory(spaceId: string): Promise<boolean> {
    const space = options.spaces.value.find(item => item.id === spaceId && item.revokedAt === null)
    const directory = space?.primaryDirectory
    if (!directory || directory.revokedAt)
      return false
    try {
      await options.api.revealFile({
        spaceId,
        directoryId: directory.id,
        revision: directory.revision,
        path: '',
      })
      return true
    }
    catch (error) {
      options.onError(error)
      return false
    }
  }

  return {
    activeSpace: readonly(activeSpace),
    createSpace,
    deleteSpace,
    activateSpaceDraft,
    openSpaceDirectory,
    selectSpaceDirectory,
    updateSpace,
  }
}
