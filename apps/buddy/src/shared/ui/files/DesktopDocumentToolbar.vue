<script setup lang="ts">
import type { FileDocumentMode } from './fileDocumentPresentation'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { Search20Regular } from '@vicons/fluent'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopContextAction from './DesktopContextAction.vue'
import DesktopDocumentModes from './DesktopDocumentModes.vue'

const props = defineProps<{ name: string, path?: string, detail?: string, modes: readonly FileDocumentMode[], language: BuddyLocale, embedded?: boolean, searchable?: boolean, searchOpen?: boolean }>()
defineEmits<{ toggleSearch: [] }>()
defineSlots<{ actions?: () => unknown }>()
const mode = defineModel<FileDocumentMode | null>({ required: true })
const { t } = useBuddyI18n(() => props.language)
</script>

<template>
  <header class="desktop-document-toolbar flex min-w-0 h-[var(--buddy-context-toolbar-height)] box-border flex-none flex-col justify-center gap-0 py-0 px-[12px] border-b-1 border-b-solid border-b-border" :class="{ 'is-embedded': embedded }">
    <div class="desktop-document-toolbar__row">
      <strong class="flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-[12px] font-600 text-strong">{{ name }}</strong>
      <div class="flex flex-none items-center gap-[6px]">
        <DesktopDocumentModes v-model="mode" :modes="modes" :language="language" />
        <DesktopContextAction v-if="searchable" data-testid="document-find-toggle" :icon="Search20Regular" :label="t('desktop.context.find')" :active="searchOpen === true" @click="$emit('toggleSearch')" />
        <slot name="actions" />
      </div>
    </div>
    <div v-if="path || detail" class="desktop-document-toolbar__metadata text-muted text-[10px] leading-[12px]">
      <span class="flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap font-mono">{{ path }}</span>
      <span class="max-w-[55%] overflow-hidden text-ellipsis whitespace-nowrap">{{ detail }}</span>
    </div>
  </header>
</template>

<style scoped lang="scss">
.desktop-document-toolbar.is-embedded { flex: 1; min-height: 0; padding: 0; border: 0; }
.desktop-document-toolbar__row, .desktop-document-toolbar__metadata { display: flex; min-width: 0; align-items: center; gap: 10px; }
</style>
