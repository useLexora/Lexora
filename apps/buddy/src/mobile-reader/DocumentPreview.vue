<script setup lang="ts">
import { computed } from 'vue'
import ChatMarkdownBody from '../shared/ui/markdown/ChatMarkdownBody.vue'
import { useDocumentPreview } from './useDocumentPreview'

const { document, selection, send } = useDocumentPreview()
const style = computed(() => ({
  ...document.value?.appearance,
  'fontSize': `${15 * (document.value?.fontScale ?? 1)}px`,
  '--buddy-chat-final-line-height': '1.6',
}))
async function copy(text: string) {
  send('copy', text)
}
function click(event: MouseEvent) {
  const link = event.target instanceof Element ? event.target.closest('a[href]') : null
  if (link) {
    event.preventDefault()
    event.stopPropagation()
    send('link', link.getAttribute('href') ?? '')
  }
}
</script>

<template>
  <main :class="{ dark: document?.dark }" :style="style" class="document-page">
    <article v-if="document" class="document-body" :aria-label="document.labels.body" @click.capture="click">
      <ChatMarkdownBody :content="document.text" :is-dark="document.dark" :animate="false" :final="true" :allow-images="false" code-overflow="scroll" :write-clipboard-text="copy" />
    </article>
    <button v-if="document?.canQuote && selection" class="quote-selection" @pointerdown.prevent @click="send('quote', selection)">
      {{ document.labels.quote }}
    </button>
  </main>
</template>

<style scoped>
.document-page { height: 100vh; overflow: auto; }
.document-body { padding: 20px 18px 88px; overflow-wrap: anywhere; }
.quote-selection { position: fixed; bottom: 12px; left: 16px; right: 16px; min-height: 48px; padding: 12px 16px; border: 1px solid var(--buddy-border-subtle); border-radius: 12px; background: var(--buddy-surface-raised); color: var(--buddy-accent-text); font: inherit; box-shadow: 0 4px 20px #0002; }
</style>
