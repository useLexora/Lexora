<script setup lang="ts">
import type { LocalChangeSetSummary } from '@buddy-shared/changes/changeApi'
import type { LocalConversationBranch, LocalConversationTimelineItem, LocalMessage } from '@buddy-shared/conversation/conversationApi'
import type { LocalRun, LocalRunOutput } from '@buddy-shared/runs/runApi'

import type { BuddyLocale } from '@/i18n/buddyI18n'
import type { ChatRunEventBuckets } from '@/modules/tasks/model/runs/typing'
import type {
  BuddyChatMessageListHandle,
  ChatMessageScrollAnchor,
  ChatMessageScrollMetrics,
} from '@/modules/tasks/widgets/transcript/chatMessageViewport'
import { computed, useTemplateRef } from 'vue'
import { createChatMessageBranchNavigatorProjector } from '@/modules/tasks/model/transcript/chatMessageBranches'
import { createChatTranscriptDisplayRowProjector } from '@/modules/tasks/model/transcript/chatMessageTime'
import { createChatRunTranscriptProjector } from '@/modules/tasks/model/transcript/chatRunTranscriptProjector'
import { createChatTranscriptProjector } from '@/modules/tasks/model/transcript/chatTranscriptProjection'
import BuddyChatMessageList from '@/modules/tasks/widgets/transcript/BuddyChatMessageList.vue'
import { useDesktopUi } from '@/shared/ui/desktopUiContext'
import { useConversationOutline } from '../workspace/useConversationOutline'

const props = defineProps<{
  activeBranchId: string
  actionsDisabled: boolean
  branches: ReadonlyArray<LocalConversationBranch>
  changeSets: ReadonlyArray<LocalChangeSetSummary>
  conversationId: string
  editingMessageId: string | null
  hasOlderMessages: boolean
  isLoadingOlderMessages: boolean
  language: BuddyLocale
  loadOutlineMessages: () => Promise<ReadonlyArray<LocalMessage>>
  runEventBuckets: ChatRunEventBuckets
  runOutputs: ReadonlyArray<LocalRunOutput>
  runs: ReadonlyArray<LocalRun>
  showReturnToLatest: boolean
  timelineItems: ReadonlyArray<LocalConversationTimelineItem>
}>()

const emit = defineEmits<{
  activateBranch: [branchId: string]
  contentResize: [metrics: ChatMessageScrollMetrics]
  editUserMessage: [messageId: string]
  openArtifact: [artifactId: string]
  openChanges: [changeSetId: string]
  readerLayoutIntent: []
  regenerateAssistant: [sourceRunId: string]
  returnToLatest: []
  selectOutlineMessage: [messageId: string]
  scroll: [metrics: ChatMessageScrollMetrics]
}>()

const messageList = useTemplateRef<BuddyChatMessageListHandle>('messageList')
const { chat } = useDesktopUi()
const activeBranchId = computed(() => props.activeBranchId)
const activeConversationId = computed(() => props.conversationId)
const runTranscriptProjector = createChatRunTranscriptProjector()
const transcriptProjector = createChatTranscriptProjector()
const displayRowProjector = createChatTranscriptDisplayRowProjector()
const branchNavigatorProjector = createChatMessageBranchNavigatorProjector()
const runProjections = computed(() => runTranscriptProjector.project(
  props.runEventBuckets,
  props.runs,
))
const transcriptProjection = computed(() => transcriptProjector.project({
  changeSets: props.changeSets,
  outputs: props.runOutputs,
  runProjections: runProjections.value,
  runs: props.runs,
  timelineItems: props.timelineItems,
}))
const displayRows = computed(() => displayRowProjector.project(transcriptProjection.value))
const branchNavigators = computed(() => branchNavigatorProjector.project(
  transcriptProjection.value,
  props.branches,
  props.activeBranchId,
))
const {
  items: outlineItems,
  isLoading: outlineLoading,
  prepare: prepareOutline,
} = useConversationOutline({
  activeBranchId,
  activeConversationId,
  loadMessages: () => props.loadOutlineMessages(),
  transcriptProjection,
})

function captureScrollAnchor(): ChatMessageScrollAnchor | null {
  return messageList.value?.captureScrollAnchor() ?? null
}

function highlightMessage(messageId: string) {
  messageList.value?.highlightMessage(messageId)
}

function readScrollMetrics(): ChatMessageScrollMetrics | null {
  return messageList.value?.readScrollMetrics() ?? null
}

function restoreScrollAnchor(anchor: ChatMessageScrollAnchor): ChatMessageScrollMetrics | null {
  return messageList.value?.restoreScrollAnchor(anchor) ?? null
}

function scrollToMessage(
  messageId: string,
  behavior?: ScrollBehavior,
): ChatMessageScrollMetrics | null {
  return messageList.value?.scrollToMessage(messageId, behavior) ?? null
}

function scrollToTail(): ChatMessageScrollMetrics | null {
  return messageList.value?.scrollToTail() ?? null
}

defineExpose<BuddyChatMessageListHandle>({
  captureScrollAnchor,
  highlightMessage,
  readScrollMetrics,
  restoreScrollAnchor,
  scrollToMessage,
  scrollToTail,
})
</script>

<template>
  <BuddyChatMessageList
    ref="messageList"
    :active-branch-id="activeBranchId"
    :actions-disabled="actionsDisabled"
    :branch-navigators="branchNavigators"
    :conversation-id="conversationId"
    :display-rows="displayRows"
    :editing-message-id="editingMessageId"
    :has-older-messages="hasOlderMessages"
    :is-loading-older-messages="isLoadingOlderMessages"
    :language="language"
    :outline-items="outlineItems"
    :outline-position="chat.outlinePosition"
    :outline-loading="outlineLoading"
    :show-return-to-latest="showReturnToLatest"
    @activate-branch="emit('activateBranch', $event)"
    @content-resize="emit('contentResize', $event)"
    @edit-user-message="emit('editUserMessage', $event)"
    @open-artifact="emit('openArtifact', $event)"
    @open-changes="emit('openChanges', $event)"
    @prepare-outline="prepareOutline"
    @reader-layout-intent="emit('readerLayoutIntent')"
    @regenerate-assistant="emit('regenerateAssistant', $event)"
    @return-to-latest="emit('returnToLatest')"
    @select-outline-message="emit('selectOutlineMessage', $event)"
    @scroll="emit('scroll', $event)"
  />
</template>
