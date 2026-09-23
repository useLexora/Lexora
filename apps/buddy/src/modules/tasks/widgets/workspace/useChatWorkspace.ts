import type { Ref } from 'vue'
import type { BuddyChatMessageListHandle } from '../transcript/chatMessageViewport'
import type { ChatWorkspaceProps } from './typing'
import { computed, shallowRef, watch } from 'vue'
import { selectDesktopChatWelcomeVariant } from '@/shared/branding/welcome/desktopChatWelcomeVariants'
import { useChatViewport } from './useChatViewport'

export function useChatWorkspace(
  props: Readonly<ChatWorkspaceProps>,
  messageList: Readonly<Ref<BuddyChatMessageListHandle | null>>,
) {
  const workspace = computed(() => props.workspace)
  const execution = computed(() => workspace.value.execution)
  const session = computed(() => workspace.value.session)
  const status = computed(() => workspace.value.status)
  const transcript = computed(() => workspace.value.transcript)
  const revealMessageId = computed(() => props.revealMessageId)
  const isEmpty = computed(() => session.value.activeConversationId.value === null)
  const welcomeVariant = shallowRef(selectDesktopChatWelcomeVariant(workspace.value.welcomePreference.value))
  const viewport = useChatViewport({
    readingPositions: props.readingPositions,
    activeBranchId: computed(() => session.value.activeBranchId.value),
    activeConversationId: computed(() => session.value.activeConversationId.value),
    revealMessageId,
    hasOlderMessages: computed(() => transcript.value.hasOlderMessages.value),
    isLoading: computed(() => status.value.isLoading.value),
    isLoadingOlderMessages: computed(() => transcript.value.isLoadingOlderMessages.value),
    list: messageList,
    loadOlderMessages: () => transcript.value.loadOlderMessages(),
    timelineItems: computed(() => transcript.value.timelineItems.value),
  })

  watch(() => execution.value.isSending.value, (sending) => {
    if (sending)
      viewport.resetToTail()
  }, { flush: 'sync' })

  watch(() => [
    session.value.activeConversationId.value,
    workspace.value.welcomePreference.value,
  ] as const, ([conversationId, preference], [previousId, previousPreference]) => {
    if (conversationId === null
      && (previousId !== null || preference !== previousPreference)) {
      welcomeVariant.value = selectDesktopChatWelcomeVariant(preference)
    }
  })

  const isLoading = computed(() => status.value.isLoading.value
    || (props.viewMode !== 'canvas' && viewport.isPositioning.value))
  const language = computed(() => workspace.value.language.value)
  const transcriptBindings = computed(() => {
    const currentSession = session.value
    const currentTranscript = transcript.value
    const currentExecution = execution.value
    const activeBranchId = currentSession.activeBranchId.value
    const conversationId = currentSession.activeConversationId.value
    if (!activeBranchId || !conversationId)
      return null
    return {
      activeBranchId,
      conversationId,
      actionsDisabled: !currentExecution.canMutateBranch.value,
      editingMessageId: currentExecution.editingMessageId.value,
      branches: currentTranscript.branches.value,
      changeSets: currentTranscript.changeSets.value,
      hasOlderMessages: currentTranscript.hasOlderMessages.value,
      isLoadingOlderMessages: currentTranscript.isLoadingOlderMessages.value,
      language: language.value,
      loadOutlineMessages: currentSession.listActiveConversationMessages,
      runEventBuckets: currentTranscript.runEventBuckets.value,
      runOutputs: currentTranscript.runOutputs.value,
      runs: currentTranscript.runs.value,
      showReturnToLatest: viewport.showReturnToLatest.value,
      timelineItems: currentTranscript.timelineItems.value,
    }
  })

  return { isEmpty, isLoading, language, transcriptBindings, viewport, welcomeVariant }
}
