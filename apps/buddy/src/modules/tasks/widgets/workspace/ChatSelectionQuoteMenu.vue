<script setup lang="ts">
import type { BuddyMessageQuote } from '@buddy-shared/conversation/buddyUserContent'
import type { ChatQuoteResult } from '../composer/chatQuoteEditing'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { TextQuote20Regular } from '@vicons/fluent'
import { useEventListener } from '@vueuse/core'
import { NDropdown, useMessage } from 'naive-ui'
import { computed, h, shallowRef, watch } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import { readChatQuoteSelection } from '../quotes/chatQuoteSelection'

const props = defineProps<{
  root: HTMLElement | null
  language: BuddyLocale
  ownerKey: string
  disabled: boolean
  addQuote: (quote: BuddyMessageQuote) => ChatQuoteResult
}>()
const emit = defineEmits<{ accepted: [] }>()
const { t } = useBuddyI18n(() => props.language)
const message = useMessage()
const pending = shallowRef<{ quote: BuddyMessageQuote, ownerKey: string } | null>(null)
const position = shallowRef({ x: 0, y: 0 })
const options = computed(() => [{ key: 'quote', label: t('desktop.chat.quoteSelection'), icon: () => h(DesktopIcon, { component: TextQuote20Regular }) }])
function close() {
  pending.value = null
}
watch([() => props.ownerKey, () => props.disabled, () => props.root], close, { flush: 'sync' })
useEventListener(() => props.root, 'contextmenu', (event: MouseEvent) => {
  close()
  if (!props.root || props.disabled)
    return
  const selected = readChatQuoteSelection(props.root, window.getSelection())
  if (!selected || !(event.target instanceof Node) || !selected.body.contains(event.target))
    return
  event.preventDefault()
  const rect = window.getSelection()!.getRangeAt(0).getBoundingClientRect()
  position.value = { x: event.clientX || rect.left, y: event.clientY || rect.bottom }
  pending.value = { quote: selected.quote, ownerKey: props.ownerKey }
}, { capture: true })
useEventListener(() => props.root, 'scroll', close, { capture: true, passive: true })
useEventListener(window, 'resize', close)
useEventListener(window, 'blur', close)
useEventListener(document, 'keydown', (event) => {
  if (pending.value && (event.key === 'Escape' || event.key === 'Tab'))
    close()
})

function selectQuote() {
  const request = pending.value
  close()
  if (!request || request.ownerKey !== props.ownerKey || props.disabled)
    return
  const result = props.addQuote(request.quote)
  if (result === 'added' || result === 'duplicate') {
    window.getSelection()?.removeAllRanges()
    if (result === 'duplicate')
      message.info(t('desktop.chat.quoteDuplicate'))
    emit('accepted')
  }
  else {
    message.warning(t(result === 'limit' ? 'desktop.chat.quoteLimit' : 'desktop.chat.quoteUnavailable'))
  }
}
</script>

<template>
  <NDropdown
    class="chat-selection-quote-menu" trigger="manual" placement="bottom-start" size="small"
    :show="pending !== null" :x="position.x" :y="position.y" :options="options"
    :menu-props="() => ({ 'class': 'buddy-selection-menu', 'role': 'menu', 'aria-label': t('desktop.chat.quoteSelection') })" :node-props="() => ({ role: 'menuitem' })"
    @select="selectQuote" @clickoutside="close" @update:show="show => !show && close()"
  />
</template>
