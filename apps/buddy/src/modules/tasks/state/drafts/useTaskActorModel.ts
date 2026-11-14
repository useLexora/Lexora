import type { LocalChatApi } from '@buddy-electron/shared/localChatApi'
import type { BuddyCatalog } from '@buddy-shared/buddies/buddyApi'
import type { ConversationModelControls, ConversationModelMutationTarget, LocalConversation } from '@buddy-shared/conversation/conversationApi'
import type { Ref } from 'vue'
import { computed, readonly, shallowRef, watch } from 'vue'

interface TaskActorModelOptions {
  activeConversation: Readonly<Ref<LocalConversation | null>>
  api: Pick<LocalChatApi['conversations'], 'getModelControls' | 'onChanged'>
  buddyCatalog?: Readonly<Ref<BuddyCatalog | null>>
  actorId: Readonly<Ref<string | null>>
  restoreModel: (selection: LocalConversation['modelSelection']) => void
  onError: (error: unknown) => void
}

export function useTaskActorModel(options: TaskActorModelOptions) {
  const response = shallowRef<{ conversationId: string, controls: ConversationModelControls } | null>(null)
  const snapshot = computed(() => response.value?.conversationId === options.activeConversation.value?.id ? response.value?.controls ?? null : null)
  const isLoading = shallowRef(false)
  let refreshRevision = 0
  let disposed = false
  let scheduled: Promise<void> | null = null
  const actorId = options.actorId
  const modelSelection = computed(() => {
    const id = actorId.value
    const memberModel = id === options.activeConversation.value?.buddyId
      ? options.activeConversation.value.modelSelection
      : snapshot.value?.next.actorId === id ? snapshot.value.next.modelSelection : null
    return memberModel ?? options.buddyCatalog?.value?.buddies.find(buddy => buddy.id === id)?.settings.model ?? null
  })
  const isLoadingModel = computed(() => isLoading.value && Boolean(options.activeConversation.value) && snapshot.value?.next.actorId !== actorId.value && actorId.value !== options.activeConversation.value?.buddyId)

  async function refresh() {
    const revision = ++refreshRevision
    const conversationId = options.activeConversation.value?.id
    const requestedActorId = actorId.value
    if (!conversationId) {
      response.value = null
      isLoading.value = false
      return
    }
    isLoading.value = true
    try {
      const value = await options.api.getModelControls(conversationId, requestedActorId ?? undefined)
      if (disposed || revision !== refreshRevision || conversationId !== options.activeConversation.value?.id || requestedActorId !== actorId.value)
        return
      response.value = { conversationId, controls: value }
      if (value.next.actorId === actorId.value)
        options.restoreModel(value.next.modelSelection)
    }
    catch (error) {
      if (!disposed && revision === refreshRevision && conversationId === options.activeConversation.value?.id && requestedActorId === actorId.value) {
        response.value = null
        options.onError(error)
      }
    }
    finally {
      if (revision === refreshRevision)
        isLoading.value = false
    }
  }

  function scheduleRefresh() {
    scheduled ??= Promise.resolve().then(async () => {
      scheduled = null
      if (!disposed)
        await refresh()
    })
    return scheduled
  }

  const stopRefresh = watch(() => [options.activeConversation.value?.id, actorId.value, options.buddyCatalog?.value?.revision], () => {
    void scheduleRefresh()
  }, { immediate: true })
  const stopChanges = options.api.onChanged((conversation) => {
    if (conversation.id === options.activeConversation.value?.id)
      void scheduleRefresh()
  })

  return {
    isLoading: readonly(isLoadingModel),
    modelSelection,
    persistTarget: () => actorId.value === options.activeConversation.value?.buddyId || (snapshot.value?.next.actorId === actorId.value && snapshot.value?.next.isMember === true),
    refresh,
    canUpdate: () => !isLoadingModel.value && (!options.activeConversation.value || actorId.value === options.activeConversation.value.buddyId || snapshot.value?.next.actorId === actorId.value),
    target: (): ConversationModelMutationTarget => {
      const controls = snapshot.value
      const current = controls?.current
      return {
        actorId: actorId.value ?? undefined,
        ...(controls?.metadataRevision !== undefined && controls.next.actorId === actorId.value
          ? {
              expectedRevision: controls.metadataRevision,
              ...current === null ? { expectedActiveRun: null } : current?.generation !== undefined ? { expectedActiveRun: { runId: current.runId, generation: current.generation, modelSelection: { ...current.modelSelection } } } : {},
            }
          : {}),
      }
    },
    dispose() {
      disposed = true
      refreshRevision++
      stopRefresh()
      stopChanges()
    },
  }
}
