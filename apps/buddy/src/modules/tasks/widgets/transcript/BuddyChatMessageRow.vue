<script setup lang="ts">
import type { LocalArtifact } from '@buddy-shared/artifacts/artifactApi'
import type { LocalChangeSetSummary } from '@buddy-shared/changes/changeApi'
import type { LocalMessage } from '@buddy-shared/conversation/conversationApi'
import type { LocalRunTokenUsage } from '@buddy-shared/usage/runTokenUsage'

import type { ChatAgentTurn } from '../../model/transcript/chatAgentTurn'
import type { ChatMessageBranchNavigator } from '../../model/transcript/chatMessageBranches'
import type { ChatTranscriptTurnOutputs } from '../../model/transcript/chatTranscriptProjection'
import type { ChatTranscriptExecutionStatus } from '../../model/transcript/chatTranscriptTypes'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { computed } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import { getChatMessageFollowupSourceId, projectChatMessageActions } from '../../model/transcript/chatMessageActions'
import {
  getChatMessageDisplayText,
} from '../../model/transcript/chatMessageContent'
import BuddyChatActionToolbar from './BuddyChatActionToolbar.vue'
import BuddyChatActorProcess from './BuddyChatActorProcess.vue'
import BuddyChatAgentIdentity from './BuddyChatAgentIdentity.vue'
import BuddyChatMessageBody from './BuddyChatMessageBody.vue'
import { useChatContent } from './chatContentContext'

const props = defineProps<{
  actionsDisabled: boolean
  branchNavigator: ChatMessageBranchNavigator | null
  editing: boolean
  canFollowup?: boolean
  followingUp?: boolean
  executionStatus?: ChatTranscriptExecutionStatus
  isIntermediate?: boolean
  showIdentity?: boolean
  showActions?: boolean
  actionMessages?: readonly LocalMessage[]
  resultRunId?: string
  ownsResultActions?: boolean
  processRunId?: string
  language: BuddyLocale
  message: LocalMessage
  streaming?: boolean
  turnChanges?: LocalChangeSetSummary | null
  turnUsage?: LocalRunTokenUsage
  turnResult?: ChatAgentTurn
  turnOutputs: ChatTranscriptTurnOutputs | null
}>()

const emit = defineEmits<{
  activateBranch: [branchId: string]
  openArtifact: [artifact: LocalArtifact]
  openChanges: [changeSetId: string]
  regenerate: [runId: string]
  followup: [assistantMessageId: string]
  startEdit: []
}>()

const { t } = useBuddyI18n(() => props.language)
const { writeClipboardText } = useChatContent()
const followupSourceId = computed(() => getChatMessageFollowupSourceId(props))
const regenerationRunId = computed(() => props.turnResult?.runId ?? (props.ownsResultActions ? props.message.runId : null))
const actions = computed(() => projectChatMessageActions(props.message, props.actionsDisabled, !!regenerationRunId.value, props.canFollowup))
const showAssistantIdentity = computed(() => (
  props.message.role === 'assistant' && props.showIdentity !== false
))
const hasActions = computed(() => (
  props.showActions !== false
  && !props.streaming
  && (
    actions.value.showCopy
    || actions.value.showEdit
    || actions.value.showRegenerate
    || actions.value.showFollowup
    || actions.value.showTime
    || props.branchNavigator !== null
  )
))
const roleLabel = computed(() => t(`message.role.${props.message.role}`))
const presentedArtifacts = computed(() => props.turnOutputs?.artifacts ?? [])
const messageText = computed(() => (props.actionMessages ?? [props.message]).map(message => getChatMessageDisplayText(
  message,
  message.id === props.message.id ? presentedArtifacts.value : [],
)).join('\n\n'))
</script>

<template>
  <article
    class="buddy-chat-message relative grid gap-[var(--buddy-chat-gap-block)] pb-[var(--buddy-chat-gap-turn)]"
    :class="[
      `is-${message.role}`,
      {
        'is-assistant-continuation': message.role === 'assistant' && showIdentity === false,
        'is-intermediate': isIntermediate,
        'is-editing': editing,
        'is-followup-source': followingUp,
        'is-streaming': streaming,
      },
    ]"
    :data-message-id="message.id"
  >
    <BuddyChatAgentIdentity
      v-if="showAssistantIdentity"
      :run-id="message.runId"
      :execution-status="executionStatus"
      :language="language"
    />
    <span
      v-else-if="message.role !== 'user' && message.role !== 'assistant'"
      class="grid w-[var(--buddy-chat-avatar-size)] min-h-[var(--buddy-chat-avatar-size)] place-items-center text-muted text-[0.65rem] font-650"
    >
      {{ roleLabel }}
    </span>
    <div v-if="editing" class="buddy-chat-message__editing-state inline-flex items-center justify-self-end gap-[0.3rem] text-accent-text text-[0.68rem] font-600 leading-[1.35]" role="status">
      <DesktopIcon name="edit" />
      <span>{{ t('desktop.chat.editingMessage') }}</span>
    </div>
    <BuddyChatMessageBody
      :final="!streaming" :language="language" :message="message" :result-run-id="resultRunId"
      :turn-outputs="turnOutputs" :turn-changes="turnChanges" :write-clipboard-text="writeClipboardText"
      @open-artifact="emit('openArtifact', $event)" @open-changes="emit('openChanges', $event)"
    />
    <BuddyChatActorProcess v-if="processRunId" :run-id="processRunId" :language="language" @open-artifact="emit('openArtifact', $event)" @open-changes="emit('openChanges', $event)" />
    <slot name="before-actions" />
    <BuddyChatActionToolbar
      v-if="hasActions"
      :actions="actions"
      :branch-navigator="branchNavigator"
      class="buddy-chat-message__actions"
      :class="{ 'has-usage': turnUsage, 'has-turn-result': turnResult, 'has-branches': branchNavigator }"
      :data-turn-result-run-id="turnResult?.runId"
      :data-task-result-run-id="turnResult?.runId"
      :copy-text="messageText"
      :created-at="message.createdAt"
      :language="language"
      :role="message.role"
      :target-key="`message-${message.id}`"
      :regenerate-target-key="turnResult ? `run-${turnResult.runId}` : undefined"
      :usage="turnUsage"
      :following-up="followingUp"
      @activate-branch="emit('activateBranch', $event)"
      @regenerate="regenerationRunId && emit('regenerate', regenerationRunId)"
      @followup="followupSourceId && emit('followup', followupSourceId)"
      @start-edit="emit('startEdit')"
    />
  </article>
</template>

<style scoped lang="scss">
.buddy-chat-message.is-assistant-continuation {
  row-gap: var(--buddy-chat-gap-tight);
}

.buddy-chat-message.is-intermediate,
.buddy-chat-message.is-streaming.is-assistant {
  padding-bottom: var(--buddy-chat-gap-block);
}

.buddy-chat-message {
  &.is-user {
    justify-items: end;
  }

  &.is-assistant {
    align-items: start;
  }

  &.is-tool {
    color: var(--buddy-text-secondary);
    font-size: 0.75rem;
  }
}

.buddy-chat-message__editing-state {
  .desktop-icon {
    font-size: 0.9rem;
  }
}

.buddy-chat-message__interruption {
  max-width: min(42rem, 92%);
  color: var(--buddy-text-secondary);
  font-size: 0.75rem;
  line-height: 1.5;
}

.buddy-chat-message__actions {
  position: absolute;
  bottom: var(--buddy-chat-gap-tight);
  left: var(--buddy-chat-inline-gutter);
  opacity: 0;
  pointer-events: none;
  transition: opacity 120ms ease;

  &.has-usage,
  .is-followup-source &,
  &.has-turn-result,
  &.has-branches {
    position: static;
  }

  &:has([data-speech-playing="true"]),
  .buddy-chat-message:hover &,
  .buddy-chat-message:has(:focus-visible) & {
    opacity: 1;
    pointer-events: auto;
  }

  .is-user & {
    right: var(--buddy-chat-inline-gutter);
    left: auto;
    justify-content: flex-end;
  }

}

@media (hover: none) {
  .buddy-chat-message__actions {
    opacity: 1;
    pointer-events: auto;
  }
}
</style>
