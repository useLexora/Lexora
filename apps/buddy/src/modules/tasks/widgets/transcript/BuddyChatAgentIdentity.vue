<script setup lang="ts">
import type { ChatTranscriptExecutionStatus } from '../../model/transcript/chatTranscriptTypes'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { BUILTIN_BUDDY_ID } from '@buddy-shared/buddies/buddyApi'
import { computed } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import { BuddyAvatar, useBuddyIdentity } from '@/modules/buddies'
import { formatChatRunDuration } from '../../model/transcript/chatRunDuration'
import { useChatBuddyId } from './chatBuddyIdentity'

const props = defineProps<{
  language: BuddyLocale
  runId?: string | null
  executionStatus?: ChatTranscriptExecutionStatus
}>()

const { t } = useBuddyI18n(() => props.language)
const buddyId = useChatBuddyId(() => props.runId)
const buddy = useBuddyIdentity(buddyId)
const name = computed(() => buddy.value?.name ?? (buddyId.value === BUILTIN_BUDDY_ID ? 'Lexora' : props.language === 'en-US' ? 'Companion' : '伙伴'))
const completed = computed(() => props.executionStatus && props.executionStatus.status !== 'queued' && props.executionStatus.status !== 'running' ? props.executionStatus : null)
const duration = computed(() => completed.value ? formatChatRunDuration(completed.value.startedAt, completed.value.completedAt, Date.now()) : null)
</script>

<template>
  <header :data-buddy-id="buddyId" :data-run-id="runId" class="buddy-chat-agent-identity inline-flex w-full min-w-0 items-center gap-[var(--buddy-chat-avatar-gap)]">
    <span class="buddy-chat-agent-identity__avatar relative w-[var(--buddy-chat-avatar-size)] h-[var(--buddy-chat-avatar-size)] overflow-hidden rounded-full">
      <BuddyAvatar :buddy-id="buddyId" :src="buddy?.avatar" />
    </span>
    <span class="buddy-chat-agent-identity__name min-w-0 leading-[var(--buddy-brand-name-line-height)]">
      {{ name }}
    </span>
    <span v-if="completed" class="buddy-chat-agent-identity__status inline-flex flex-none items-baseline gap-[6px] ml-auto text-[length:var(--buddy-chat-tool-font-size)] leading-[20px]" :class="completed.status === 'failed' ? 'text-danger' : 'text-muted'" :data-execution-status-run-id="runId">
      <span class="buddy-chat-agent-identity__status-label">{{ t(`run.status.${completed.status}`) }}</span>
      <span class="buddy-chat-agent-identity__duration tabular-nums">{{ duration }}</span>
    </span>
  </header>
</template>

<style scoped lang="scss">
.buddy-chat-agent-identity__avatar {
  flex: 0 0 auto;
}

.buddy-chat-agent-identity__avatar img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.buddy-chat-agent-identity__name {
  color: var(--buddy-chat-agent-name-color);
  font-family: var(--buddy-font-brand);
  font-size: var(--buddy-brand-name-font-size);
  font-weight: var(--buddy-brand-name-font-weight);
}
</style>
