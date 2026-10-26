<script setup lang="ts">
import type { LocalRunTokenUsage } from '@buddy-shared/usage/runTokenUsage'
import type { ChatMessageBranchNavigator } from '../../model/transcript/chatMessageBranches'

import type { ChatAgentTurn } from '../../model/transcript/chatStreamingMessage'
import type { ChatTranscriptExecutionStatus } from '../../model/transcript/chatTranscriptTypes'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { computed } from 'vue'

import { useBuddyI18n } from '@/i18n/buddyI18n'
import {
  resolveChatAgentTurnFailurePresentation,
  resolveChatAgentTurnNotice,
} from '../../model/transcript/chatAgentTurnDisclosure'
import { projectChatAgentTurnActions } from '../../model/transcript/chatMessageActions'
import BuddyChatActionToolbar from './BuddyChatActionToolbar.vue'
import BuddyChatAgentIdentity from './BuddyChatAgentIdentity.vue'
import BuddyChatAgentTurnFlow from './BuddyChatAgentTurnFlow.vue'

const props = defineProps<{
  actionsDisabled?: boolean
  branchNavigator?: ChatMessageBranchNavigator | null
  language: BuddyLocale
  executionStatus?: ChatTranscriptExecutionStatus
  ownsResultActions?: boolean
  resultUsage?: LocalRunTokenUsage | null
  showIdentity?: boolean
  showOutcome?: boolean
  turn: ChatAgentTurn
}>()

const emit = defineEmits<{
  activateBranch: [branchId: string]
  regenerate: []
}>()

const { t } = useBuddyI18n(() => props.language)
const isActive = computed(() => props.turn.status === 'queued' || props.turn.status === 'running')
const statusLabel = computed(() => t(`run.status.${props.turn.status}`))
const notice = computed(() => resolveChatAgentTurnNotice(
  props.turn.status,
  props.turn.failureMessage ?? null,
))
const failurePresentation = computed(() => notice.value?.kind === 'failure'
  ? resolveChatAgentTurnFailurePresentation(
      props.turn.failureCode ?? null,
      notice.value.message,
    )
  : null)
const resultNoticeText = computed(() => {
  if (props.showOutcome === false)
    return null
  if (!notice.value)
    return null
  if (notice.value.placement !== 'result')
    return null
  if (notice.value.kind === 'cancelled')
    return t('desktop.chat.runCancelled')
  return failurePresentation.value?.message
    ?? t(failurePresentation.value?.messageKey ?? 'desktop.chat.runFailed')
})

const failureDetailText = computed(() => props.showOutcome === false ? null : failurePresentation.value?.detail ?? null)
const actions = computed(() => projectChatAgentTurnActions(
  props.turn,
  props.actionsDisabled ?? false,
  props.ownsResultActions ?? false,
))
const showActions = computed(() => props.showOutcome !== false && (
  actions.value.showCopy
  || actions.value.showRegenerate
  || actions.value.showTime
  || props.branchNavigator != null
))
const actionCopyText = computed(() => resultNoticeText.value ?? statusLabel.value)
</script>

<template>
  <section
    class="buddy-chat-agent-turn grid min-w-0 items-start"
    :class="[`is-${turn.status}`, { 'is-assistant-continuation': showIdentity === false }]"
  >
    <BuddyChatAgentIdentity v-if="showIdentity !== false" :run-id="turn.runId" :execution-status="executionStatus" :language="language" />
    <BuddyChatAgentTurnFlow
      v-if="turn.nodes.length || failureDetailText"
      :failure-detail-text="failureDetailText"
      :language="language"
      :nodes="turn.nodes"
    />
    <p
      v-if="resultNoticeText"
      class="buddy-chat-agent-turn__result mt-[var(--buddy-chat-gap-section)] mr-0 mb-0 ml-0 text-[14px] leading-[1.6] whitespace-pre-wrap"
      :data-task-result-run-id="!isActive ? turn.runId : undefined"
      :class="{ 'is-failure': notice?.kind === 'failure' }"
    >
      {{ resultNoticeText }}
    </p>
    <slot name="before-actions" />
    <BuddyChatActionToolbar
      v-if="showActions"
      :actions="actions"
      :branch-navigator="branchNavigator ?? null"
      class="buddy-chat-agent-turn__actions"
      :copy-text="actionCopyText"
      :created-at="turn.completedAt ?? turn.startedAt"
      :language="language"
      role="assistant"
      :target-key="`run-${turn.runId}`"
      :usage="ownsResultActions ? resultUsage : null"
      @activate-branch="emit('activateBranch', $event)"
      @regenerate="emit('regenerate')"
    />
  </section>
</template>

<style scoped lang="scss">
.buddy-chat-agent-turn {
  color: var(--buddy-chat-process-color);
}

.buddy-chat-agent-turn__result {
  color: var(--buddy-chat-tool-body-color);

  &.is-failure {
    color: var(--buddy-chat-danger-color);
  }
}

.buddy-chat-agent-turn__actions {
  opacity: 0;
  pointer-events: none;
  transition: opacity 120ms ease;

  .buddy-chat-agent-turn:hover &,
  .buddy-chat-agent-turn:focus-within & {
    opacity: 1;
    pointer-events: auto;
  }
}

@media (prefers-reduced-motion: reduce) {
  .buddy-chat-agent-turn__actions {
    transition: none;
  }
}

@media (hover: none) {
  .buddy-chat-agent-turn__actions {
    opacity: 1;
    pointer-events: auto;
  }
}
</style>
