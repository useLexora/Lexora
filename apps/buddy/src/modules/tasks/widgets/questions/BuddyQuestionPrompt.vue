<script setup lang="ts">
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { computed } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopMarkdownContent from '@/shared/ui/markdown/DesktopMarkdownContent.vue'
import { useChatContent } from '../transcript/chatContentContext'

const props = defineProps<{ content: string, language: BuddyLocale, position: number, total: number, multiple?: boolean }>()
const { t } = useBuddyI18n(() => props.language)
const actions = useChatContent()
const multiline = computed(() => props.content.includes('\n'))
</script>

<template>
  <div class="buddy-question-prompt min-w-0" :class="multiline ? 'grid gap-2' : 'flex items-start gap-3'">
    <div v-if="total > 1 || multiple" class="flex shrink-0 items-center gap-2 whitespace-nowrap text-[length:var(--buddy-chat-caption-font-size)] text-muted leading-[var(--buddy-chat-final-line-height)]" :class="multiline ? 'justify-between' : 'order-last'">
      <span v-if="total > 1">{{ t('questions.position', { current: position, total }) }}</span>
      <span v-if="multiple">{{ t('questions.multiple') }}</span>
    </div>
    <DesktopMarkdownContent
      class="min-w-0 flex-1 font-normal text-fg"
      :content="content"
      :language="language"
      :allow-images="false"
      code-overflow="wrap"
      :write-clipboard-text="actions.writeClipboardText"
      :open-web-link="actions.openWebLink"
      :file-link-menu="actions.fileLinkMenu"
      :on-link-error="actions.onLinkError"
      @open-link="actions.previewFile"
    />
  </div>
</template>

<style scoped lang="scss">
.buddy-question-prompt :deep(.markstream-vue) {
  --ms-text-h1: var(--buddy-chat-final-font-size);
  --ms-text-h2: var(--buddy-chat-final-font-size);
  --ms-text-h3: var(--buddy-chat-final-font-size);
  --ms-leading-h1: var(--buddy-chat-final-line-height);
  --ms-leading-h2: var(--buddy-chat-final-line-height);
  --ms-leading-h3: var(--buddy-chat-final-line-height);
}
</style>
