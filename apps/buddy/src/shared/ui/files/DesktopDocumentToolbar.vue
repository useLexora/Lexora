<script setup lang="ts">
import type { FileDocumentMode } from './fileDocumentPresentation'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import DesktopDocumentModes from './DesktopDocumentModes.vue'

defineProps<{ name: string, path?: string, detail?: string, modes: readonly FileDocumentMode[], language: BuddyLocale, embedded?: boolean }>()
defineSlots<{ actions?: () => unknown }>()
const mode = defineModel<FileDocumentMode | null>({ required: true })
</script>

<template>
  <header class="desktop-document-toolbar" :class="{ 'is-embedded': embedded }">
    <div class="desktop-document-toolbar__row">
      <strong class="desktop-document-toolbar__name">{{ name }}</strong>
      <div class="desktop-document-toolbar__actions">
        <DesktopDocumentModes v-model="mode" :modes="modes" :language="language" />
        <slot name="actions" />
      </div>
    </div>
    <div v-if="path || detail" class="desktop-document-toolbar__metadata">
      <span class="desktop-document-toolbar__path">{{ path }}</span>
      <span class="desktop-document-toolbar__detail">{{ detail }}</span>
    </div>
  </header>
</template>

<style scoped>
.desktop-document-toolbar { display: flex; min-width: 0; height: var(--buddy-context-toolbar-height); box-sizing: border-box; flex: none; flex-direction: column; justify-content: center; gap: 0; padding: 0 12px; border-bottom: 1px solid var(--buddy-border-subtle); }
.desktop-document-toolbar.is-embedded { flex: 1; min-height: 0; padding: 0; border: 0; }
.desktop-document-toolbar__row, .desktop-document-toolbar__metadata { display: flex; min-width: 0; align-items: center; gap: 10px; }
.desktop-document-toolbar__name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; font-weight: 600; color: var(--buddy-text-strong); }
.desktop-document-toolbar__actions { display: flex; flex: none; align-items: center; gap: 6px; }
.desktop-document-toolbar__metadata { color: var(--buddy-text-muted); font-size: 10px; line-height: 12px; }
.desktop-document-toolbar__path { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--buddy-font-mono); }
.desktop-document-toolbar__detail { max-width: 55%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
