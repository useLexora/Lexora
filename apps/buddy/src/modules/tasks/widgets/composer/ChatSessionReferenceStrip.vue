<script setup lang="ts">
import type { BuddySessionReference } from '@buddy-shared/conversation/buddyUserContent'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { Chat20Regular, Dismiss16Regular } from '@vicons/fluent'
import { NButton, NTooltip } from 'naive-ui'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'

const props = defineProps<{ references: readonly BuddySessionReference[], language: BuddyLocale, removable?: boolean, disabled?: boolean }>()
const emit = defineEmits<{ remove: [id: string] }>()
const { t } = useBuddyI18n(() => props.language)
</script>

<template>
  <div v-if="references.length" class="chat-session-reference-strip" data-session-reference-exclude>
    <div v-for="reference in references" :key="reference.id" class="chat-session-reference" :title="reference.title">
      <DesktopIcon :component="Chat20Regular" class="chat-session-reference__icon" />
      <NTooltip :delay="300">
        <template #trigger>
          <span class="chat-session-reference__title">{{ reference.title }}</span>
        </template>{{ reference.title }}
      </NTooltip>
      <NButton v-if="removable" class="buddy-icon-button chat-session-reference__remove" quaternary size="tiny" :disabled="disabled" :aria-label="t('desktop.chat.removeSessionReference')" @click="emit('remove', reference.id)">
        <template #icon>
          <DesktopIcon :component="Dismiss16Regular" />
        </template>
      </NButton>
    </div>
  </div>
</template>

<style scoped>
.chat-session-reference-strip { display: flex; min-width: 0; max-width: 100%; gap: 8px; overflow-x: auto; padding-bottom: 6px; }
.chat-session-reference { display: flex; flex: 0 0 auto; width: 180px; max-width: 100%; min-width: 0; align-items: center; gap: 8px; border: 1px solid var(--buddy-border-subtle); border-radius: var(--buddy-radius-micro); background: var(--buddy-surface-raised); padding: 6px 8px; }
.chat-session-reference__icon { flex: none; color: var(--buddy-accent-text); }
.chat-session-reference__title { display: block; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
.chat-session-reference__remove { flex: none; margin-left: auto; }
</style>
