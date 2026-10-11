<script setup lang="ts">
import type { BuddySessionReference } from '@buddy-shared/conversation/buddyUserContent'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { Chat20Regular } from '@vicons/fluent'
import { inject } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import ChatReferenceCard from './ChatReferenceCard.vue'
import { sessionReferenceNavigationKey } from './sessionReferenceNavigation'

const props = defineProps<{ references: readonly BuddySessionReference[], language: BuddyLocale, removable?: boolean, disabled?: boolean }>()
const emit = defineEmits<{ remove: [id: string] }>()
const { t } = useBuddyI18n(() => props.language)
const navigate = inject(sessionReferenceNavigationKey, null)
</script>

<template>
  <div v-if="references.length" class="chat-session-reference-strip flex min-w-0 max-w-full gap-[8px] overflow-x-auto pb-[6px]" data-quote-exclude>
    <ChatReferenceCard
      v-for="reference in references" :key="reference.id" class="chat-session-reference" :data-session-id="reference.id"
      :icon="Chat20Regular" :label="t('desktop.chat.sessionReferences')" :text="reference.title"
      :removable="removable" :disabled="disabled" :remove-label="t('desktop.chat.removeSessionReference')"
      @navigate="navigate?.(reference.id)" @remove="emit('remove', reference.id)"
    />
  </div>
</template>

<style scoped lang="scss">
.chat-session-reference-strip { overscroll-behavior-inline: contain; }
</style>
