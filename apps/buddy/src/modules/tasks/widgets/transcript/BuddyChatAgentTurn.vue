<script setup lang="ts">
import type { ChatMessageBranchNavigator } from '../../model/transcript/chatMessageBranches'

import type { ChatAgentTurn } from '../../model/transcript/chatStreamingMessage'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { computed, useTemplateRef } from 'vue'

import { useBuddyI18n } from '@/i18n/buddyI18n'
import {
  resolveChatAgentTurnFailurePresentation,
  resolveChatAgentTurnNotice,
} from '../../model/transcript/chatAgentTurnDisclosure'
import { projectChatAgentTurnActions } from '../../model/transcript/chatMessageActions'
import { formatChatRunDuration } from '../../model/transcript/chatRunDuration'
import BuddyChatActionToolbar from './BuddyChatActionToolbar.vue'
import BuddyChatAgentIdentity from './BuddyChatAgentIdentity.vue'
import BuddyChatAgentTurnFlow from './BuddyChatAgentTurnFlow.vue'

const props = defineProps<{
  actionsDisabled?: boolean
  branchNavigator?: ChatMessageBranchNavigator | null
  language: BuddyLocale
  ownsResultActions?: boolean
  showIdentity?: boolean
  showOutcome?: boolean
  turn: ChatAgentTurn
}>()

const emit = defineEmits<{
  activateBranch: [branchId: string]
  regenerate: []
}>()

const { t } = useBuddyI18n(() => props.language)
const flow = useTemplateRef('flow')
defineExpose({ revealActivity: (nodeId: string) => flow.value?.revealActivity(nodeId) })
const isActive = computed(() => props.turn.status === 'queued' || props.turn.status === 'running')
const duration = computed(() => formatChatRunDuration(
  props.turn.startedAt,
  props.turn.completedAt,
  Date.now(),
))
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
    class="buddy-chat-agent-turn"
    :class="`is-${turn.status}`"
  >
    <div v-if="showIdentity !== false" class="buddy-chat-agent-turn__heading">
      <BuddyChatAgentIdentity :language="language" />
      <div v-if="!isActive" class="buddy-chat-agent-turn__status">
        <span class="buddy-chat-agent-turn__status-label">{{ statusLabel }}</span>
        <span class="buddy-chat-agent-turn__duration">{{ duration }}</span>
      </div>
    </div>
    <BuddyChatAgentTurnFlow
      v-if="turn.nodes.length || failureDetailText"
      ref="flow"
      :failure-detail-text="failureDetailText"
      :language="language"
      :nodes="turn.nodes"
    />
    <p
      v-if="resultNoticeText"
      class="buddy-chat-agent-turn__result"
      :data-task-result-run-id="!isActive ? turn.runId : undefined"
      :class="{ 'is-failure': notice?.kind === 'failure' }"
    >
      {{ resultNoticeText }}
    </p>
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
      :usage="ownsResultActions ? turn.usage : null"
      @activate-branch="emit('activateBranch', $event)"
      @regenerate="emit('regenerate')"
    />
  </section>
</template>

<style scoped lang="scss">
.buddy-chat-agent-turn {
  display: grid;
  min-width: 0;
  align-items: start;
  color: var(--buddy-chat-process-color);
}

.buddy-chat-agent-turn__heading {
  display: flex;
  min-width: 0;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.buddy-chat-agent-turn__status {
  display: inline-flex;
  flex: none;
  align-items: baseline;
  gap: 6px;
  color: var(--buddy-text-muted);
  font-size: var(--buddy-chat-tool-font-size);
  line-height: 20px;
}

.buddy-chat-agent-turn__duration {
  font-variant-numeric: tabular-nums;
}

.buddy-chat-agent-turn.is-failed .buddy-chat-agent-turn__status {
  color: var(--buddy-chat-danger-color);
}

.buddy-chat-agent-turn__result {
  margin: var(--buddy-chat-gap-section) 0 0;
  color: var(--buddy-chat-tool-body-color);
  font-size: 14px;
  line-height: 1.6;
  white-space: pre-wrap;

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
