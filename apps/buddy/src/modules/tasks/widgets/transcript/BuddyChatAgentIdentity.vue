<script setup lang="ts">
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { BUILTIN_BUDDY_ID } from '@buddy-shared/buddies/buddyApi'
import { computed } from 'vue'
import { BuddyAvatar, useBuddyIdentity } from '@/modules/buddies'
import { useChatBuddyId } from './chatBuddyIdentity'

const props = defineProps<{
  language: BuddyLocale
  runId?: string | null
}>()

const buddyId = useChatBuddyId(() => props.runId)
const buddy = useBuddyIdentity(buddyId)
const name = computed(() => buddy.value?.name ?? (buddyId.value === BUILTIN_BUDDY_ID ? 'Lexora' : props.language === 'en-US' ? 'Companion' : '伙伴'))
</script>

<template>
  <header :data-buddy-id="buddyId" class="buddy-chat-agent-identity inline-flex w-fit min-w-0 items-center gap-[var(--buddy-chat-avatar-gap)]">
    <span class="buddy-chat-agent-identity__avatar relative w-[var(--buddy-chat-avatar-size)] h-[var(--buddy-chat-avatar-size)] overflow-hidden rounded-full">
      <BuddyAvatar :buddy-id="buddyId" :src="buddy?.avatar" />
    </span>
    <span class="buddy-chat-agent-identity__name min-w-0 leading-[var(--buddy-brand-name-line-height)]">
      {{ name }}
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
