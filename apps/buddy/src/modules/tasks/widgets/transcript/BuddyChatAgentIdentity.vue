<script setup lang="ts">
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import { BRAND_ASSET_URLS } from '@/shared/branding/brandAssets'

const props = defineProps<{
  language: BuddyLocale
}>()

const { t } = useBuddyI18n(() => props.language)
</script>

<template>
  <header class="buddy-chat-agent-identity inline-flex w-fit min-w-0 items-center gap-[var(--buddy-chat-avatar-gap)]">
    <span class="buddy-chat-agent-identity__avatar relative w-[var(--buddy-chat-avatar-size)] h-[var(--buddy-chat-avatar-size)] overflow-hidden rounded-full">
      <img
        :src="BRAND_ASSET_URLS.chatAvatar"
        alt=""
        draggable="false"
      >
    </span>
    <span class="buddy-chat-agent-identity__name min-w-0 leading-[var(--buddy-brand-name-line-height)]">
      {{ t('desktop.chat.agentName') }}
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
