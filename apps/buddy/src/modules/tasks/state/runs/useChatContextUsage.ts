import type { LexoraDesktopApi } from '@buddy-electron/shared/desktopApi'
import type { LocalContextUsageSnapshot, LocalContextUsageSnapshotRequest } from '@buddy-shared/conversation/contextApi'
import type { BuddyServiceTier, BuddyThinkingLevel } from '@buddy-shared/conversation/modelSelection'
import type { BuddyApprovalPolicy } from '@buddy-shared/permissions/approvalPolicy'
import type { BuddyExecutionProfile } from '@buddy-shared/permissions/executionProfile'

import type { LocalRuntimeModelOption } from '@buddy-shared/providers/providerApi'
import type { LocalRunEvent } from '@buddy-shared/runs/runApi'
import type { LocalBuddyServiceSupervisorState } from '@buddy-shared/runtime/serviceState'
import type { Ref } from 'vue'
import { computed, shallowRef, watch } from 'vue'
import { createChatContextUsage } from '@/modules/tasks/model/runs/chatContextUsage'

interface UseChatContextUsageOptions {
  actorId?: Readonly<Ref<string | null>>
  runId?: Readonly<Ref<string | null>>
  runRevision?: Readonly<Ref<string | null>>
  activeBranchId: Readonly<Ref<string | null>>
  activeConversationId: Readonly<Ref<string | null>>
  approvalPolicy: Readonly<Ref<BuddyApprovalPolicy>>
  api: LexoraDesktopApi['localChat']['context']
  draftId: Readonly<Ref<string>>
  executionProfile: Readonly<Ref<BuddyExecutionProfile>>
  models: Readonly<Ref<ReadonlyArray<LocalRuntimeModelOption>>>
  spaceId: Readonly<Ref<string | null>>
  runSignalEvents: Readonly<Ref<ReadonlyArray<LocalRunEvent>>>
  runtimeState: Readonly<Ref<LocalBuddyServiceSupervisorState>>
  selectedEffort: Readonly<Ref<BuddyThinkingLevel | null>>
  selectedModel: Readonly<Ref<LocalRuntimeModelOption | null>>
  selectedServiceTier: Readonly<Ref<BuddyServiceTier | null>>
}

export function useChatContextUsage(options: UseChatContextUsageOptions) {
  const snapshot = shallowRef<LocalContextUsageSnapshot | null>(null)
  let requestId = 0
  const target = computed<LocalContextUsageSnapshotRequest | null>(() => {
    const model = options.selectedModel.value
    if (!model || ((options.activeConversationId.value === null) !== (options.activeBranchId.value === null)))
      return null
    return {
      actorId: options.actorId?.value ?? undefined,
      runId: options.runId?.value ?? undefined,
      approvalPolicy: options.approvalPolicy.value,
      branchId: options.activeBranchId.value,
      conversationId: options.activeConversationId.value,
      draftId: options.draftId.value,
      executionProfile: options.executionProfile.value,
      modelSelection: { modelId: model.modelId, providerId: model.providerId, reasoning: options.selectedEffort.value, serviceTier: options.selectedServiceTier.value },
      spaceId: options.spaceId.value,
    }
  })

  const contextUsage = computed(() => createChatContextUsage({
    events: options.runId?.value
      ? snapshot.value ? options.runSignalEvents.value.filter(event => event.runId === options.runId!.value) : []
      : options.runSignalEvents.value,
    models: options.models.value,
    selectedModel: options.selectedModel.value,
    snapshot: snapshot.value,
  }))
  const stopRefreshWatch = watch(
    () => [
      options.runtimeState.value.status,
      options.actorId?.value,
      options.runId?.value,
      options.selectedModel.value?.providerId ?? null,
      options.selectedModel.value?.modelId ?? null,
      options.selectedEffort.value,
      options.selectedServiceTier.value,
      options.activeConversationId.value,
      options.activeBranchId.value,
      options.spaceId.value,
      options.approvalPolicy.value,
      options.executionProfile.value,
      options.draftId.value,
    ] as const,
    () => void refresh(true),
    { immediate: true, flush: 'sync' },
  )

  const stopRunRefreshWatch = watch(() => [options.runId?.value, options.runRevision?.value] as const, ([runId], [previousRunId]) => {
    if (runId && runId === previousRunId)
      void refresh(false)
  })

  async function refresh(clear = true) {
    const currentRequestId = ++requestId
    const input = target.value
    if (options.runtimeState.value.status !== 'ready' || !input) {
      snapshot.value = null
      return
    }

    if (clear)
      snapshot.value = null
    try {
      const nextSnapshot = await options.api.getUsageSnapshot(input)
      if (currentRequestId === requestId)
        snapshot.value = nextSnapshot
    }
    catch {
      if (currentRequestId === requestId)
        snapshot.value = null
    }
  }

  function dispose() {
    requestId += 1
    stopRefreshWatch()
    stopRunRefreshWatch()
    snapshot.value = null
  }

  return {
    target,
    contextUsage,
    dispose,
    refresh,
  }
}
