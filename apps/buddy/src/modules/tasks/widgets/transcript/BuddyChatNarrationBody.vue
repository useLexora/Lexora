<script setup lang="ts">
import type { BuddyLocale } from '@/i18n/buddyI18n'
import DesktopMarkdownContent from '@/shared/ui/markdown/DesktopMarkdownContent.vue'
import { useChatContent } from './chatContentContext'

defineProps<{
  language: BuddyLocale
  text: string
}>()

const actions = useChatContent()

function handleMarkdownLink(href: string) {
  if (actions.canPreviewFile(href))
    actions.previewFile(href)
}
</script>

<template>
  <DesktopMarkdownContent
    class="buddy-chat-narration-body"
    :content="text"
    :language="language"
    :write-clipboard-text="actions.writeClipboardText"
    @open-link="handleMarkdownLink"
  />
</template>

<style scoped lang="scss">
.buddy-chat-narration-body {
  margin: 6px 0;
  color: var(--buddy-text-primary);
  --buddy-chat-final-font-size: 14px;
  --buddy-chat-final-line-height: 1.6;
  --buddy-chat-final-heading-font-size: 14px;
}
</style>
