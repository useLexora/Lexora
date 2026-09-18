<script setup lang="ts">
import type { FileDocumentMode } from './fileDocumentPresentation'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import DesktopMarkdownContent from '@/shared/ui/markdown/DesktopMarkdownContent.vue'
import DesktopMonacoFile from './DesktopMonacoFile.vue'

withDefaults(defineProps<{ mode: FileDocumentMode | null, name: string, text?: string | null, imageUrl?: string | null, language: BuddyLocale, writeClipboardText: (text: string) => Promise<void>, wrap?: boolean }>(), { wrap: true })
defineSlots<{ source?: () => unknown }>()
</script>

<template>
  <div class="desktop-document-content">
    <article v-if="mode === 'preview' && text != null" class="desktop-document-content__markdown">
      <DesktopMarkdownContent :content="text" code-overflow="scroll" :language="language" :write-clipboard-text="writeClipboardText" />
    </article>
    <div v-else-if="mode === 'preview' && imageUrl" class="desktop-document-content__image">
      <img :src="imageUrl" :alt="name">
    </div>
    <template v-else-if="(mode === 'source' || mode === 'edit') && text != null">
      <slot name="source">
        <DesktopMonacoFile :text="text" :path="name" :wrap="wrap" />
      </slot>
    </template>
    <div v-else class="desktop-document-content__empty">
      {{ name }}
    </div>
  </div>
</template>

<style scoped>
.desktop-document-content { display: flex; flex: 1; flex-direction: column; min-width: 0; min-height: 0; overflow: hidden; background: var(--buddy-surface-base); }
.desktop-document-content__markdown { flex: 1; min-height: 0; overflow: auto; padding: 20px 24px 32px; color: var(--buddy-text-primary); font-family: var(--buddy-font-ui); overflow-wrap: anywhere; --buddy-chat-final-font-size: 0.875rem; --buddy-chat-final-line-height: 1.75; }
.desktop-document-content__image { display: grid; flex: 1; min-height: 0; overflow: auto; padding: 16px; place-items: center; }
.desktop-document-content__image img { max-width: 100%; max-height: 100%; object-fit: contain; }
.desktop-document-content__empty { display: grid; flex: 1; min-height: 0; place-content: center; padding: 24px; overflow-wrap: anywhere; color: var(--buddy-text-muted); font-size: 13px; }
</style>
