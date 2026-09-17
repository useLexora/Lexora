<script setup lang="ts">
import type { LocalChangeSetSummary } from '@buddy-shared/changes/changeApi'
import type { LocalMessage } from '@buddy-shared/conversation/conversationApi'
import type { LocalRunTokenUsage } from '@buddy-shared/usage/runTokenUsage'

import type { ChatMessageBranchNavigator } from '../../model/transcript/chatMessageBranches'
import type { ChatTranscriptTurnOutputs } from '../../model/transcript/chatTranscriptProjection'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { computed } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import { projectChatMessageActions } from '../../model/transcript/chatMessageActions'
import {
  getChatMessageDisplayText,
} from '../../model/transcript/chatMessageContent'
import BuddyChatActionToolbar from './BuddyChatActionToolbar.vue'
import BuddyChatAgentIdentity from './BuddyChatAgentIdentity.vue'
import BuddyChatMessageBody from './BuddyChatMessageBody.vue'
import { useChatContent } from './chatContentContext'

const props = defineProps<{
  actionsDisabled: boolean
  activeSearch: boolean
  branchNavigator: ChatMessageBranchNavigator | null
  editing: boolean
  isIntermediate?: boolean
  showIdentity?: boolean
  resultRunId?: string
  language: BuddyLocale
  message: LocalMessage
  searchMatch: boolean
  streaming?: boolean
  turnChanges?: LocalChangeSetSummary | null
  turnUsage?: LocalRunTokenUsage
  turnOutputs: ChatTranscriptTurnOutputs | null
}>()

const emit = defineEmits<{
  activateBranch: [branchId: string]
  openArtifact: [artifactId: string]
  openChanges: [changeSetId: string]
  regenerate: []
  startEdit: []
}>()

const { t } = useBuddyI18n(() => props.language)
const { writeClipboardText } = useChatContent()
const actions = computed(() => projectChatMessageActions(props.message, props.actionsDisabled))
const showAssistantIdentity = computed(() => (
  props.message.role === 'assistant' && props.showIdentity !== false
))
const showActions = computed(() => (
  !props.streaming
  && !props.isIntermediate
  && (
    actions.value.showCopy
    || actions.value.showEdit
    || actions.value.showRegenerate
    || actions.value.showTime
    || props.branchNavigator !== null
  )
))
const roleLabel = computed(() => t(`message.role.${props.message.role}`))
const presentedArtifacts = computed(() => props.turnOutputs?.artifacts ?? [])
const messageText = computed(() => getChatMessageDisplayText(
  props.message,
  presentedArtifacts.value,
))
</script>

<template>
  <article
    class="buddy-chat-message"
    :class="[
      `is-${message.role}`,
      {
        'is-search-active': activeSearch,
        'is-assistant-continuation': message.role === 'assistant' && showIdentity === false,
        'is-intermediate': isIntermediate,
        'is-editing': editing,
        'is-search-match': searchMatch,
        'is-streaming': streaming,
      },
    ]"
    :data-message-id="message.id"
  >
    <BuddyChatAgentIdentity
      v-if="showAssistantIdentity"
      :language="language"
    />
    <span
      v-else-if="message.role !== 'user' && message.role !== 'assistant'"
      class="buddy-chat-message__role"
    >
      {{ roleLabel }}
    </span>
    <div v-if="editing" class="buddy-chat-message__editing-state" role="status">
      <DesktopIcon name="messageEdit" />
      <span>{{ t('desktop.chat.editingMessage') }}</span>
    </div>
    <BuddyChatMessageBody
      :final="!streaming" :language="language" :message="message" :result-run-id="resultRunId"
      :turn-outputs="turnOutputs" :turn-changes="turnChanges" :write-clipboard-text="writeClipboardText"
      @open-artifact="emit('openArtifact', $event)" @open-changes="emit('openChanges', $event)"
    />
    <BuddyChatActionToolbar
      v-if="showActions"
      :actions="actions"
      :branch-navigator="branchNavigator"
      class="buddy-chat-message__actions"
      :class="{ 'has-usage': turnUsage }"
      :copy-text="messageText"
      :created-at="message.createdAt"
      :language="language"
      :role="message.role"
      :target-key="`message-${message.id}`"
      :usage="turnUsage"
      @activate-branch="emit('activateBranch', $event)"
      @regenerate="emit('regenerate')"
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
  position: relative;
  display: grid;
  gap: var(--buddy-chat-gap-block);
  padding-bottom: var(--buddy-chat-gap-turn);

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

.buddy-chat-message__role {
  display: grid;
  width: var(--buddy-chat-avatar-size);
  min-height: var(--buddy-chat-avatar-size);
  place-items: center;
  color: var(--buddy-text-muted);
  font-size: 0.65rem;
  font-weight: 650;
}

.buddy-chat-message__editing-state {
  display: inline-flex;
  align-items: center;
  justify-self: end;
  gap: 0.3rem;
  color: var(--buddy-accent-text);
  font-size: 0.68rem;
  font-weight: 600;
  line-height: 1.35;

  .desktop-icon {
    font-size: 0.9rem;
  }
}

.buddy-chat-message.is-search-match :deep(.buddy-chat-message-content__text) {
  border-radius: 0.6rem;
  background: var(--buddy-status-warning-surface);
  box-shadow: inset 2px 0 var(--buddy-status-warning-border);
}

.buddy-chat-message.is-search-active :deep(.buddy-chat-message-content__text) {
  outline: 1px solid var(--buddy-status-warning-border);
  outline-offset: 1px;
}

.buddy-chat-message.is-assistant.is-search-match :deep(.buddy-chat-message-content__text) {
  width: fit-content;
  max-width: 100%;
  justify-self: start;
  padding: 0.35rem 0.55rem;
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

  &.has-usage {
    position: static;
  }

  .buddy-chat-message:hover &,
  .buddy-chat-message:focus-within & {
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
