import type { LexoraDesktopApi } from '@buddy-electron/shared/desktopApi'
import type { LocalContextUsageSnapshotRequest } from '@buddy-shared/conversation/contextApi'
import type { BuddyServiceTier, BuddyThinkingLevel } from '@buddy-shared/conversation/modelSelection'
import type { BuddyApprovalPolicy } from '@buddy-shared/permissions/approvalPolicy'
import type { BuddyExecutionProfile } from '@buddy-shared/permissions/executionProfile'

import type { LocalRuntimeModelOption } from '@buddy-shared/providers/providerApi'
import type { LocalRunEvent } from '@buddy-shared/runs/runApi'
import type { LocalBuddyServiceSupervisorState } from '@buddy-shared/runtime/serviceState'
import type { Ref } from 'vue'
import type { ChatContextUsageState } from '@/modules/tasks/model/runs/chatContextUsage'
import { computed, shallowRef, watch } from 'vue'
import { createChatContextUsage, updateChatContextUsage } from '@/modules/tasks/model/runs/chatContextUsage'

interface UseChatContextUsageOptions {
  actorId?: Readonly<Ref<string | null>>
  runId?: Readonly<Ref<string | null>>
  threadId?: Readonly<Ref<string | null>>
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
  const usageState = shallowRef<ChatContextUsageState | null>(null)
  const hasSnapshot = shallowRef(false)
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

  const scopedEvents = computed(() => options.runSignalEvents.value.filter(event => (
    (!options.runId?.value || event.runId === options.runId.value)
    && (event.type !== 'context.usage.updated'
      || (event.payload.provider === options.selectedModel.value?.providerId
        && event.payload.model === options.selectedModel.value?.modelId))
  )))
  const contextUsage = computed(() => createChatContextUsage({
    state: usageState.value,
    models: options.models.value,
    selectedModel: options.selectedModel.value,
  }))
  const scope = computed(() => JSON.stringify([
    options.runtimeState.value.status,
    options.actorId?.value,
    options.threadId?.value ?? options.runId?.value,
    options.selectedModel.value?.providerId ?? null,
    options.selectedModel.value?.modelId ?? null,
    options.selectedModel.value?.contextWindow ?? null,
    options.selectedEffort.value,
    options.selectedServiceTier.value,
    options.activeConversationId.value,
    options.activeBranchId.value,
    options.spaceId.value,
    options.approvalPolicy.value,
    options.executionProfile.value,
    options.draftId.value,
  ]))
  const stopRefreshWatch = watch(
    () => [scope.value, options.runId?.value] as const,
    ([scope], previous) => void refresh(scope !== previous?.[0]),
    { immediate: true, flush: 'sync' },
  )

  const stopUsageWatch = watch(
    () => options.runId?.value && !hasSnapshot.value ? [] : scopedEvents.value,
    (events) => {
      const next = updateChatContextUsage(usageState.value, { events })
      if (next.compaction !== usageState.value?.compaction && next.compaction)
        requestId += 1
      usageState.value = next
    },
    { immediate: true, flush: 'sync' },
  )

  const stopRunRefreshWatch = watch(() => [options.runId?.value, options.runRevision?.value] as const, ([runId], [previousRunId]) => {
    if (runId === previousRunId)
      void refresh(false)
  })

  async function refresh(clear = true) {
    const currentRequestId = ++requestId
    const input = target.value
    if (options.runtimeState.value.status !== 'ready' || !input) {
      hasSnapshot.value = false
      usageState.value = null
      return
    }

    if (clear) {
      hasSnapshot.value = false
      usageState.value = updateChatContextUsage(null, { events: options.runId?.value ? [] : scopedEvents.value })
    }
    try {
      const snapshot = await options.api.getUsageSnapshot(input)
      if (currentRequestId === requestId) {
        usageState.value = updateChatContextUsage(usageState.value, { snapshot, events: scopedEvents.value })
        hasSnapshot.value = true
      }
    }
    catch {}
  }

  function dispose() {
    requestId += 1
    stopRefreshWatch()
    stopRunRefreshWatch()
    stopUsageWatch()
    usageState.value = null
    hasSnapshot.value = false
  }

  return {
    target,
    contextUsage,
    dispose,
    refresh,
  }
}
