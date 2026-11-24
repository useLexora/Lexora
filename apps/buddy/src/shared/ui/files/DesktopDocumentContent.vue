<script setup lang="ts">
import type { BuddyTextQuote } from '@buddy-shared/conversation/buddyUserContent'
import type { FileDocumentMode } from './fileDocumentPresentation'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import type { MarkdownImageResolver } from '@/shared/ui/markdown/markdownImage'
import type { PrepareResourceQuote } from '@/shared/ui/selection/useResourceSelectionQuote'
import { computed, onScopeDispose, useTemplateRef, watch } from 'vue'
import DesktopMarkdownContent from '@/shared/ui/markdown/DesktopMarkdownContent.vue'
import DesktopMediaPreview from '@/shared/ui/media/DesktopMediaPreview.vue'
import { readResourceTextSelection } from '@/shared/ui/selection/resourceQuoteSelection'
import { useQuoteHighlight } from '@/shared/ui/selection/useQuoteHighlight'
import DesktopMonacoFile from './DesktopMonacoFile.vue'
import { documentFindRanges } from './documentFind'
import { createDocumentFindHighlighter } from './documentFindHighlight'

const props = withDefaults(defineProps<{ mode: FileDocumentMode | null, name: string, text?: string | null, imageUrl?: string | null, mediaKind?: 'audio' | 'video' | null, mediaUrl?: string | null, resolveImage?: MarkdownImageResolver, visible?: boolean, language: BuddyLocale, writeClipboardText: (text: string) => Promise<void>, wrap?: boolean, sourceReady?: boolean, revealSource?: (quote: BuddyTextQuote) => boolean, quoteSource?: BuddyTextQuote['source'], prepareQuote?: PrepareResourceQuote, findOpen?: boolean, findQuery?: string, findIndex?: number, findPaused?: boolean }>(), { wrap: true, visible: true, findOpen: false, findQuery: '', findIndex: 0, findPaused: false })
const emit = defineEmits<{ previewError: [], findResult: [result: { count: number, capped: boolean }] }>()
defineSlots<{ source?: () => unknown, preview?: () => unknown }>()
const markdown = useTemplateRef<HTMLElement>('markdown')
const monaco = useTemplateRef<InstanceType<typeof DesktopMonacoFile>>('monaco')
const highlight = useQuoteHighlight('buddy-resource-quote')
const findHighlighter = createDocumentFindHighlighter()
let findFrame = 0
let findResultKey = ''
function publishFind(count: number, capped: boolean) {
  const key = `${count}:${capped}`
  if (key === findResultKey)
    return
  findResultKey = key
  emit('findResult', { count, capped })
}
function applyPreviewFind() {
  if (props.mode !== 'preview' || !props.findOpen) {
    findHighlighter.clear()
    findResultKey = ''
    return
  }
  if (props.findPaused)
    return
  const root = markdown.value
  if (!root) {
    publishFind(0, false)
    return
  }
  const { ranges, capped } = documentFindRanges(root, props.findQuery)
  findHighlighter.show(ranges, props.findIndex, root)
  publishFind(ranges.length, capped)
}
function schedulePreviewFind() {
  if (typeof requestAnimationFrame !== 'function') {
    applyPreviewFind()
    return
  }
  cancelAnimationFrame(findFrame)
  findFrame = requestAnimationFrame(() => applyPreviewFind())
}
watch([markdown, () => props.findOpen, () => props.findQuery, () => props.findIndex, () => props.findPaused, () => props.mode, () => props.text], () => {
  schedulePreviewFind()
}, { flush: 'post' })
watch([markdown, () => props.findOpen, () => props.mode], ([element, open, mode], _, onCleanup) => {
  if (!element || !open || mode !== 'preview')
    return
  const observer = new MutationObserver(() => schedulePreviewFind())
  observer.observe(element, { subtree: true, childList: true, characterData: true })
  onCleanup(() => {
    observer.disconnect()
    cancelAnimationFrame(findFrame)
  })
})
onScopeDispose(() => {
  cancelAnimationFrame(findFrame)
  findHighlighter.dispose()
})
const ready = computed(() => props.mode === 'preview' ? !!markdown.value : props.sourceReady ?? monaco.value?.ready ?? false)
function reveal(quote: BuddyTextQuote) {
  if (props.mode === 'preview')
    return !!markdown.value && highlight.show(markdown.value, quote, markdown.value)
  return props.revealSource?.(quote) ?? monaco.value?.reveal(quote) ?? false
}
defineExpose({ ready, reveal })
function quoteText(event: MouseEvent) {
  if (!props.quoteSource || !props.prepareQuote || !(event.currentTarget instanceof HTMLElement))
    return
  const quote = readResourceTextSelection(event.currentTarget, window.getSelection(), props.quoteSource)
  if (!quote || !(event.target instanceof Node) || !window.getSelection()?.containsNode(event.target, true))
    return
  const show = props.prepareQuote(quote, event.clientX, event.clientY, 'menu')
  if (show) {
    event.preventDefault()
    show()
  }
}
</script>

<template>
  <div class="desktop-document-content flex flex-1 flex-col min-w-0 min-h-0 overflow-hidden bg-surface">
    <slot v-if="mode === 'preview' && $slots.preview" name="preview" />
    <DesktopMediaPreview v-else-if="mode === 'preview' && mediaKind && mediaUrl" :kind="mediaKind" :src="mediaUrl" :name="name" :language="language" :visible="visible" />
    <article v-else-if="mode === 'preview' && text != null" ref="markdown" class="desktop-document-content__markdown flex-1 min-h-0 overflow-auto pt-[20px] pr-[24px] pb-[32px] pl-[24px] text-fg font-sans [overflow-wrap:anywhere]" @contextmenu="quoteText">
      <DesktopMarkdownContent :content="text" :resolve-image="resolveImage" code-overflow="scroll" :language="language" :write-clipboard-text="writeClipboardText" />
    </article>
    <div v-else-if="mode === 'preview' && imageUrl" class="desktop-document-content__image grid flex-1 min-h-0 overflow-auto p-[16px] place-items-center">
      <img :key="imageUrl" :src="imageUrl" :alt="name" @error="$emit('previewError')">
    </div>
    <template v-else-if="(mode === 'source' || mode === 'edit') && text != null">
      <slot name="source">
        <DesktopMonacoFile ref="monaco" :language="language" :text="text" :path="name" :wrap="wrap" :quote-source="quoteSource" :prepare-quote="prepareQuote" :find-open="findOpen && (mode === 'source' || mode === 'edit')" :find-query="findQuery" :find-index="findIndex" @find-result="emit('findResult', $event)" />
      </slot>
    </template>
    <div v-else class="desktop-document-content__empty grid flex-1 min-h-0 p-[24px] [overflow-wrap:anywhere] text-muted text-[13px]">
      {{ name }}
    </div>
  </div>
</template>

<style scoped lang="scss">
.desktop-document-content__markdown :deep(::highlight(buddy-resource-quote)) { background: var(--buddy-accent-solid); color: var(--buddy-text-on-accent); }
.desktop-document-content__markdown { --buddy-chat-final-font-size: 0.875rem; --buddy-chat-final-line-height: 1.75; }
.desktop-document-content__image img { max-width: 100%; max-height: 100%; object-fit: contain; }
.desktop-document-content__empty { place-content: center; }
</style>
