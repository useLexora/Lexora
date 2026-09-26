<script setup lang="ts">
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import { BRAND_ASSET_URLS } from '@/shared/branding/brandAssets'

const props = defineProps<{
  as?: 'header' | 'span'
  language: BuddyLocale
}>()

const { t } = useBuddyI18n(() => props.language)
</script>

<template>
  <component :is="props.as ?? 'header'" class="buddy-chat-agent-identity">
    <span class="buddy-chat-agent-identity__avatar">
      <img
        :src="BRAND_ASSET_URLS.chatAvatar"
        alt=""
        draggable="false"
      >
    </span>
    <span class="buddy-chat-agent-identity__name">
      {{ t('desktop.chat.agentName') }}
    </span>
  </component>
</template>

<style scoped lang="scss">
.buddy-chat-agent-identity {
  display: inline-flex;
  width: fit-content;
  min-width: 0;
  align-items: center;
  gap: var(--buddy-chat-avatar-gap);
}

.buddy-chat-agent-identity__avatar {
  position: relative;
  width: var(--buddy-chat-avatar-size);
  height: var(--buddy-chat-avatar-size);
  flex: 0 0 auto;
  overflow: hidden;
  border-radius: 50%;
}

.buddy-chat-agent-identity__avatar img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.buddy-chat-agent-identity__name {
  min-width: 0;
  color: var(--buddy-chat-agent-name-color);
  font-family: var(--buddy-font-brand);
  font-size: var(--buddy-brand-name-font-size);
  font-weight: var(--buddy-brand-name-font-weight);
  line-height: var(--buddy-brand-name-line-height);
}
</style>
