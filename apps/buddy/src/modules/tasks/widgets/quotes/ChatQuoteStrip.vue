<script setup lang="ts">
import type { BuddyMessageQuote } from '@buddy-shared/conversation/buddyUserContent'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { provide } from 'vue'
import ChatInputMaterialStrip from '../materials/ChatInputMaterialStrip.vue'
import { chatQuoteNavigationKey } from './chatQuoteContext'

const props = defineProps<{
  quotes: readonly BuddyMessageQuote[]
  language: BuddyLocale
  removable?: boolean
  disabled?: boolean
  navigate?: (quote: BuddyMessageQuote) => void
}>()
const emit = defineEmits<{ remove: [id: string] }>()
if (props.navigate)
  provide(chatQuoteNavigationKey, async quote => props.navigate?.(quote))
</script>

<template>
  <ChatInputMaterialStrip
    :materials="quotes.map(quote => ({ kind: 'message_quote', id: quote.id, quote }))"
    :language="language" :removable="removable" :disabled="disabled"
    @remove="emit('remove', $event.id)"
  />
</template>
