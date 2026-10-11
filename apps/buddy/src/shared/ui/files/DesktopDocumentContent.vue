<script setup lang="ts">
import type { FileDocumentMode } from './fileDocumentPresentation'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import DesktopMarkdownContent from '@/shared/ui/markdown/DesktopMarkdownContent.vue'
import DesktopMonacoFile from './DesktopMonacoFile.vue'

withDefaults(defineProps<{ mode: FileDocumentMode | null, name: string, text?: string | null, imageUrl?: string | null, language: BuddyLocale, writeClipboardText: (text: string) => Promise<void>, wrap?: boolean }>(), { wrap: true })
defineSlots<{ source?: () => unknown }>()
</script>

<template>
  <div class="desktop-document-content flex flex-1 flex-col min-w-0 min-h-0 overflow-hidden bg-surface">
    <article v-if="mode === 'preview' && text != null" class="desktop-document-content__markdown flex-1 min-h-0 overflow-auto pt-[20px] pr-[24px] pb-[32px] pl-[24px] text-fg font-sans [overflow-wrap:anywhere]">
      <DesktopMarkdownContent :content="text" code-overflow="scroll" :language="language" :write-clipboard-text="writeClipboardText" />
    </article>
    <div v-else-if="mode === 'preview' && imageUrl" class="desktop-document-content__image grid flex-1 min-h-0 overflow-auto p-[16px] place-items-center">
      <img :src="imageUrl" :alt="name">
    </div>
    <template v-else-if="(mode === 'source' || mode === 'edit') && text != null">
      <slot name="source">
        <DesktopMonacoFile :text="text" :path="name" :wrap="wrap" />
      </slot>
    </template>
    <div v-else class="desktop-document-content__empty grid flex-1 min-h-0 p-[24px] [overflow-wrap:anywhere] text-muted text-[13px]">
      {{ name }}
    </div>
  </div>
</template>

<style scoped lang="scss">
.desktop-document-content__markdown { --buddy-chat-final-font-size: 0.875rem; --buddy-chat-final-line-height: 1.75; }
.desktop-document-content__image img { max-width: 100%; max-height: 100%; object-fit: contain; }
.desktop-document-content__empty { place-content: center; }
</style>
