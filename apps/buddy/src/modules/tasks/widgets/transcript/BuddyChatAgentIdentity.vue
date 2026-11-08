<script setup lang="ts">
import type { ChatTranscriptExecutionStatus } from '../../model/transcript/chatTranscriptTypes'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { BUILTIN_BUDDY_ID } from '@buddy-shared/buddies/buddyApi'
import { computed } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import { BuddyAvatar, useBuddyIdentity } from '@/modules/buddies'
import { formatChatRunDuration } from '../../model/transcript/chatRunDuration'
import { useChatActorMention } from './chatActorMentionContext'
import { useChatBuddyId } from './chatBuddyIdentity'

const props = defineProps<{
  language: BuddyLocale
  runId?: string | null
  executionStatus?: ChatTranscriptExecutionStatus
}>()

const { t } = useBuddyI18n(() => props.language)
const actorId = useChatBuddyId(() => props.runId, '')
const buddyId = computed(() => actorId.value || BUILTIN_BUDDY_ID)
const buddy = useBuddyIdentity(buddyId)
const mention = useChatActorMention()
const canMention = computed(() => Boolean(actorId.value && buddy.value?.kind === 'actor'
  && buddy.value.enabled && !buddy.value.deletedAt && mention?.canMentionActor(actorId.value)))
function mentionActor() {
  if (canMention.value && buddy.value)
    mention?.mentionActor({ type: 'actor_ref', actorId: actorId.value, name: buddy.value.name })
}
const name = computed(() => buddy.value?.name ?? (buddyId.value === BUILTIN_BUDDY_ID ? 'Lexora' : props.language === 'en-US' ? 'Companion' : '伙伴'))
const completed = computed(() => props.executionStatus && props.executionStatus.status !== 'queued' && props.executionStatus.status !== 'running' ? props.executionStatus : null)
const duration = computed(() => completed.value ? formatChatRunDuration(completed.value.startedAt, completed.value.completedAt, Date.now()) : null)
</script>

<template>
  <header :data-buddy-id="buddyId" :data-run-id="runId" class="buddy-chat-agent-identity inline-flex w-full min-w-0 items-center gap-[var(--buddy-chat-avatar-gap)]">
    <button
      type="button"
      class="buddy-chat-agent-identity__mention ui-focus-ring inline-flex min-w-0 items-center gap-[var(--buddy-chat-avatar-gap)] border-0 rounded-micro bg-transparent p-0 text-left text-[var(--buddy-chat-agent-name-color)] transition-state-colors enabled:cursor-pointer enabled:hover:text-accent-text enabled:focus-visible:text-accent-text"
      :disabled="!canMention"
      @mousedown.prevent
      @click="mentionActor"
    >
      <span class="buddy-chat-agent-identity__avatar relative flex-none w-[var(--buddy-chat-avatar-size)] h-[var(--buddy-chat-avatar-size)] overflow-hidden rounded-full">
        <BuddyAvatar :buddy-id="buddyId" :src="buddy?.avatar" class="block w-full h-full" />
      </span>
      <span class="buddy-chat-agent-identity__name relative min-w-0 overflow-hidden leading-[var(--buddy-brand-name-line-height)]" :class="{ 'pr-[1em]': canMention }">
        <span class="buddy-chat-agent-identity__label block truncate">{{ name }}</span>
        <span v-if="canMention" class="buddy-chat-agent-identity__hint absolute left-0 top-0 w-[1em]" aria-hidden="true">@</span>
      </span>
    </button>
    <span v-if="completed" class="buddy-chat-agent-identity__status inline-flex flex-none items-baseline gap-[6px] ml-auto text-[length:var(--buddy-chat-tool-font-size)] leading-[20px]" :class="completed.status === 'failed' ? 'text-danger' : 'text-muted'" :data-execution-status-run-id="runId">
      <span class="buddy-chat-agent-identity__status-label">{{ t(`run.status.${completed.status}`) }}</span>
      <span class="buddy-chat-agent-identity__duration tabular-nums">{{ duration }}</span>
    </span>
  </header>
</template>

<style scoped lang="scss">
.buddy-chat-agent-identity__label,
.buddy-chat-agent-identity__hint {
  transition: transform calc(var(--buddy-motion-state-duration) * 2) var(--buddy-motion-state-easing);
}

.buddy-chat-agent-identity__hint {
  transform: translateX(-100%);
}

.buddy-chat-agent-identity__mention:enabled:is(:hover, :focus-visible) {
  .buddy-chat-agent-identity__label {
    transform: translateX(1em);
  }

  .buddy-chat-agent-identity__hint {
    transform: translateX(0);
  }
}

.buddy-chat-agent-identity__name {
  font-family: var(--buddy-font-brand);
  font-size: var(--buddy-brand-name-font-size);
  font-weight: var(--buddy-brand-name-font-weight);
}
</style>
