<script setup lang="ts">
import type { BuddyTextQuote } from '@buddy-shared/conversation/buddyUserContent'
import type { FileDocumentMode } from './fileDocumentPresentation'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import type { MarkdownImageResolver } from '@/shared/ui/markdown/markdownImage'
import type { PrepareResourceQuote } from '@/shared/ui/selection/useResourceSelectionQuote'
import { computed, shallowRef, useTemplateRef, watch } from 'vue'
import DesktopMarkdownContent from '@/shared/ui/markdown/DesktopMarkdownContent.vue'
import DesktopMediaPreview from '@/shared/ui/media/DesktopMediaPreview.vue'
import { readResourceTextSelection } from '@/shared/ui/selection/resourceQuoteSelection'
import { useQuoteHighlight } from '@/shared/ui/selection/useQuoteHighlight'
import DesktopMonacoFile from './DesktopMonacoFile.vue'

const props = withDefaults(defineProps<{ mode: FileDocumentMode | null, name: string, text?: string | null, imageUrl?: string | null, imageCrossOrigin?: boolean, mediaKind?: 'audio' | 'video' | null, mediaUrl?: string | null, resolveImage?: MarkdownImageResolver, visible?: boolean, language: BuddyLocale, writeClipboardText: (text: string) => Promise<void>, wrap?: boolean, sourceReady?: boolean, revealSource?: (quote: BuddyTextQuote) => boolean, quoteSource?: BuddyTextQuote['source'], prepareQuote?: PrepareResourceQuote }>(), { wrap: true, visible: true, imageCrossOrigin: false })
defineEmits<{ previewError: [] }>()
defineSlots<{ source?: () => unknown, preview?: () => unknown, imageOverlay?: () => unknown }>()
const markdown = useTemplateRef<HTMLElement>('markdown')
const image = useTemplateRef<HTMLImageElement>('image')
const corsImage = useTemplateRef<HTMLImageElement>('corsImage')
const corsFailed = shallowRef(false)
watch(() => props.imageUrl, () => corsFailed.value = false, { flush: 'sync' })
watch([corsImage, () => props.imageUrl], ([element, src]) => {
  if (!element || !src)
    return
  const url = new URL(src)
  url.searchParams.set('v', crypto.randomUUID())
  element.crossOrigin = 'anonymous'
  element.src = url.href
}, { flush: 'post' })
const monaco = useTemplateRef<InstanceType<typeof DesktopMonacoFile>>('monaco')
const highlight = useQuoteHighlight('buddy-resource-quote')
const ready = computed(() => props.mode === 'preview' ? !!markdown.value : props.sourceReady ?? monaco.value?.ready ?? false)
function reveal(quote: BuddyTextQuote) {
  if (props.mode === 'preview')
    return !!markdown.value && highlight.show(markdown.value, quote, markdown.value)
  return props.revealSource?.(quote) ?? monaco.value?.reveal(quote) ?? false
}
function onCorsImageError(event: Event) {
  if (event.currentTarget === corsImage.value)
    corsFailed.value = true
}
defineExpose({ ready, reveal, getImageElement: () => corsImage.value ?? image.value })
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
    <div v-else-if="mode === 'preview' && imageUrl" class="desktop-document-content__image relative grid flex-1 min-h-0 overflow-auto p-[16px] place-items-center">
      <img v-if="imageCrossOrigin && !corsFailed" ref="corsImage" :key="imageUrl" :alt="name" draggable="false" @error="onCorsImageError">
      <img v-else ref="image" :key="imageUrl" :src="imageUrl" :alt="name" draggable="false" @error="$emit('previewError')">
      <slot name="imageOverlay" />
    </div>
    <template v-else-if="(mode === 'source' || mode === 'edit') && text != null">
      <slot name="source">
        <DesktopMonacoFile ref="monaco" :language="language" :text="text" :path="name" :wrap="wrap" :quote-source="quoteSource" :prepare-quote="prepareQuote" />
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
