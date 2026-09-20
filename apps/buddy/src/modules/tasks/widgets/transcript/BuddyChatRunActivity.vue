<script setup lang="ts">
import type { ChatAgentTurn } from '../../model/transcript/chatStreamingMessage'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { ChevronRight20Regular } from '@vicons/fluent'
import { useIntervalFn } from '@vueuse/core'
import { computed, shallowRef } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import { describeChatCurrentActivity } from '../../model/transcript/chatCurrentActivity'
import { formatChatRunDuration } from '../../model/transcript/chatRunDuration'
import BuddyChatActivityStatus from './BuddyChatActivityStatus.vue'
import BuddyChatDisclosure from './BuddyChatDisclosure.vue'
import BuddyChatReasoningBody from './BuddyChatReasoningBody.vue'

const props = defineProps<{
  language: BuddyLocale
  turn: ChatAgentTurn
}>()
const emit = defineEmits<{ revealActivity: [nodeId: string] }>()
const { t } = useBuddyI18n(() => props.language)
const now = shallowRef(Date.now())
const expandedReasoningId = shallowRef<string | null>(null)
const revealedToolId = shallowRef<string | null>(null)
const activity = computed(() => describeChatCurrentActivity(props.turn, props.language))
const reasoningOpen = computed(() => activity.value?.reasoning != null && expandedReasoningId.value === activity.value.reasoning.id)
useIntervalFn(() => {
  now.value = Date.now()
}, 1_000, { immediateCallback: true })
const duration = computed(() => formatChatRunDuration(props.turn.startedAt, props.turn.completedAt, now.value))
const actionLabel = computed(() => t(activity.value?.reasoning
  ? 'desktop.chat.activityViewReasoning'
  : (activity.value?.tools.length ?? 0) > 1 ? 'desktop.chat.activityNextCall' : 'desktop.chat.activityViewCall'))

function reveal() {
  const current = activity.value
  if (current?.reasoning) {
    expandedReasoningId.value = reasoningOpen.value ? null : current.reasoning.id
    return
  }
  if (!current?.tools.length)
    return
  const index = current.tools.findIndex(node => node.id === revealedToolId.value)
  const node = current.tools[(index + 1) % current.tools.length]!
  revealedToolId.value = node.id
  emit('revealActivity', node.id)
}
</script>

<template>
  <div v-if="activity" class="buddy-chat-run-activity">
    <BuddyChatActivityStatus :label="activity.label" :target="reasoningOpen ? '' : activity.target" :detail="activity.detail" active>
      <button
        v-if="activity.reasoning || activity.tools.length"
        class="buddy-chat-run-activity__reveal" :class="{ 'is-open': reasoningOpen }" type="button"
        :aria-label="actionLabel" :aria-expanded="activity.reasoning ? reasoningOpen : undefined"
        @click="reveal"
      >
        <DesktopIcon :component="ChevronRight20Regular" class="buddy-chat-activity-row__chevron" aria-hidden="true" />
      </button>
      <span class="buddy-chat-run-activity__duration" aria-live="off">{{ duration }}</span>
    </BuddyChatActivityStatus>
    <BuddyChatDisclosure>
      <BuddyChatReasoningBody v-if="reasoningOpen && activity.reasoning" :key="activity.reasoning.id" :text="activity.reasoning.text" class="buddy-chat-run-activity__reasoning" />
    </BuddyChatDisclosure>
  </div>
</template>

<style scoped lang="scss">
@use './chatActivityRow' as activity;

.buddy-chat-activity-row__chevron { @include activity.chevron; }

.buddy-chat-run-activity {
  min-width: 0;
  padding-bottom: var(--buddy-chat-gap-turn);
}

.buddy-chat-run-activity__duration {
  min-width: 3.5ch;
  flex: none;
  color: var(--buddy-text-muted);
  font-size: var(--buddy-chat-tool-font-size);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.buddy-chat-run-activity__reveal {
  display: grid;
  width: 24px;
  height: 24px;
  flex: none;
  place-items: center;
  padding: 4px;
  border: 0;
  border-radius: var(--buddy-radius-micro);
  background: transparent;
  color: var(--buddy-text-muted);
  cursor: pointer;

  &.is-open :deep(.n-icon) { transform: rotate(90deg); }
  &:hover { background: var(--buddy-state-hover); color: var(--buddy-text-secondary); }
  &:focus-visible { outline: 2px solid var(--buddy-focus-ring); outline-offset: 2px; }
}

.buddy-chat-run-activity__reasoning { margin-top: 4px; padding-inline-start: var(--buddy-chat-activity-indent); }
</style>
