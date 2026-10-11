<script setup lang="ts">
import { computed } from 'vue'
import { renderChatMarkdown } from './chatMarkdown'

const props = defineProps<{
  text: string
}>()

const bodyHtml = computed(() => renderChatMarkdown(props.text))
</script>

<template>
  <div
    v-if="text"
    class="buddy-chat-reasoning-entry__body min-w-0 m-0 text-muted text-[length:var(--buddy-chat-tool-font-size)] leading-[1.7] [overflow-wrap:anywhere] py-1 px-0"
    v-html="bodyHtml"
  />
</template>

<style scoped lang="scss">
.buddy-chat-reasoning-entry__body {
  :deep(> :first-child) {
    margin-top: 0;
  }

  :deep(> :last-child) {
    margin-bottom: 0;
  }

  :deep(h1),
  :deep(h2),
  :deep(h3),
  :deep(h4),
  :deep(h5),
  :deep(h6) {
    font-size: inherit;
    font-weight: 500;
    margin: 0.5em 0;
  }

  :deep(strong) {
    font-weight: 500;
  }

  :deep(p) {
    margin: 0.35rem 0;
  }

  :deep(pre) {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
}
</style>
