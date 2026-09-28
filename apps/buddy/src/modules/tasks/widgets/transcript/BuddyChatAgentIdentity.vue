<script setup lang="ts">
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { computed } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import { BRAND_ASSET_URLS } from '@/shared/branding/brandAssets'
import { useDesktopUi } from '@/shared/ui/desktopUiContext'

const props = defineProps<{
  language: BuddyLocale
}>()

const { t } = useBuddyI18n(() => props.language)
const { agentIdentity } = useDesktopUi()
const agentName = computed(() => agentIdentity.value.name.trim() || t('desktop.chat.agentName'))
const agentAvatar = computed(() => agentIdentity.value.avatar.trim() || BRAND_ASSET_URLS.chatAvatar)
const agentInitials = computed(() => agentIdentity.value.initials)
</script>

<template>
  <header class="buddy-chat-agent-identity">
    <span class="buddy-chat-agent-identity__avatar" :style="agentInitials ? { background: agentIdentity.avatarColor ?? undefined } : undefined">
      <span v-if="agentInitials" class="buddy-chat-agent-identity__initials">{{ agentInitials }}</span>
      <img
        v-else
        :src="agentAvatar"
        alt=""
        draggable="false"
      >
    </span>
    <span class="buddy-chat-agent-identity__name">
      {{ agentName }}
    </span>
  </header>
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

.buddy-chat-agent-identity__initials {
  display: grid;
  width: 100%;
  height: 100%;
  place-items: center;
  color: var(--buddy-text-on-accent);
  font-size: calc(var(--buddy-chat-avatar-size) * 0.45);
  font-weight: 600;
  line-height: 1;
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
