import type { ChatDrafts } from '../drafts/typing'
import type { UseChatTurnExecutionOptions } from './useChatTurnExecution'
import type { UseChatBranchMutationsOptions } from '@/modules/tasks/state/conversations/useChatBranchMutations'
import { computed } from 'vue'
import { useChatBranchMutations } from '@/modules/tasks/state/conversations/useChatBranchMutations'
import { useComposerTarget } from '../composer/useComposerTarget'
import { useChatTurnExecution } from './useChatTurnExecution'

type UseChatExecutionOptions = Omit<UseChatTurnExecutionOptions, 'composerTarget'> & Omit<UseChatBranchMutationsOptions, 'isSending' | 'composerTarget'> & { drafts: ChatDrafts }

export function useChatExecution(options: UseChatExecutionOptions) {
  const composerTarget = useComposerTarget({
    drafts: options.drafts,
    conversationId: options.session.activeConversationId,
    branchId: options.session.activeBranchId,
    persist: options.persistWorkspaceState,
  })
  const turnExecution = useChatTurnExecution({
    activeRun: options.activeRun,
    approvalPolicy: options.approvalPolicy,
    api: options.api,
    canSendDraft: options.canSendDraft,
    taskIndexData: options.taskIndexData,
    session: options.session,
    drafts: options.drafts,
    composerTarget,
    draftScopeKey: options.draftScopeKey,
    draftChangedMessage: options.draftChangedMessage,
    executionProfile: options.executionProfile,
    getRunTerminationMessage: options.getRunTerminationMessage,
    isUpdatingPermissionSettings: options.isUpdatingPermissionSettings,
    language: options.language,
    modelSelection: options.modelSelection,
    onActionCommandRunStarted: options.onActionCommandRunStarted,
    onDraftCommitted: options.onDraftCommitted,
    persistWorkspaceState: options.persistWorkspaceState,
    runSync: options.runSync,
    runtimeSupervisor: options.runtimeSupervisor,
    setErrorMessage: options.setErrorMessage,
    unavailableCommandMessage: options.unavailableCommandMessage,
  })
  const branchMutations = useChatBranchMutations({
    composerTarget,
    activeRun: options.activeRun,
    api: options.api,
    canSendDraft: options.canSendDraft,
    drafts: options.drafts,
    taskIndexData: options.taskIndexData,
    session: options.session,
    isSending: turnExecution.isSending,
    isUpdatingPermissionSettings: options.isUpdatingPermissionSettings,
    language: options.language,
    modelSelection: options.modelSelection,
    refreshBranches: options.refreshBranches,
    persistWorkspaceState: options.persistWorkspaceState,
    selectComposerSource: options.selectComposerSource,
    runSync: options.runSync,
    runtimeSupervisor: options.runtimeSupervisor,
    setErrorMessage: options.setErrorMessage,
  })

  return {
    composerTarget,
    beginFollowup: (target: Parameters<typeof composerTarget.beginFollowup>[0]) => composerTarget.beginFollowup(target, () => branchMutations.canMutateBranch.value),
    cancelFollowup: composerTarget.cancelFollowup,
    ...branchMutations,
    ...turnExecution,
    canSend: computed(() => turnExecution.canSend.value && !branchMutations.isMutatingBranch.value),
    send: (payload: Parameters<typeof turnExecution.send>[0]) => branchMutations.isMutatingBranch.value
      ? Promise.resolve(false)
      : turnExecution.send(payload),
  }
}
