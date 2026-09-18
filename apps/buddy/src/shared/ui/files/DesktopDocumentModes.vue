<script setup lang="ts">
import type { FileDocumentMode } from './fileDocumentPresentation'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { Code16Regular, Edit16Regular, Eye16Regular } from '@vicons/fluent'
import { NTooltip } from 'naive-ui'
import { computed } from 'vue'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'

const props = defineProps<{ modes: readonly FileDocumentMode[], language: BuddyLocale }>()
const mode = defineModel<FileDocumentMode | null>({ required: true })
const icons = { preview: Eye16Regular, source: Code16Regular, edit: Edit16Regular }
const labels = computed(() => props.language === 'en-US'
  ? { preview: 'Preview', source: 'Source', edit: 'Edit' }
  : { preview: '预览', source: '源码', edit: '编辑' })
function navigate(event: KeyboardEvent, index: number) {
  const next = event.key === 'Home'
    ? 0
    : event.key === 'End'
      ? props.modes.length - 1
      : event.key === 'ArrowRight'
        ? (index + 1) % props.modes.length
        : event.key === 'ArrowLeft' ? (index + props.modes.length - 1) % props.modes.length : -1
  if (next < 0)
    return
  event.preventDefault()
  mode.value = props.modes[next]!
  const group = (event.currentTarget as HTMLElement).parentElement
  group?.querySelectorAll<HTMLButtonElement>('button')[next]?.focus()
}
</script>

<template>
  <div v-if="modes.length > 1" class="desktop-document-modes" role="tablist">
    <NTooltip v-for="(item, index) in modes" :key="item" trigger="hover" :delay="350">
      <template #trigger>
        <button type="button" role="tab" :data-testid="`document-mode-${item}`" :aria-label="labels[item]" :aria-selected="mode === item" :tabindex="mode === item ? 0 : -1" :class="{ 'is-active': mode === item }" @click="mode = item" @keydown="navigate($event, index)">
          <DesktopIcon :component="icons[item]" :size="14" aria-hidden="true" />
        </button>
      </template>
      {{ labels[item] }}
    </NTooltip>
  </div>
</template>

<style scoped>
.desktop-document-modes { display: inline-flex; flex: none; gap: 2px; padding: 2px; border-radius: 6px; background: var(--buddy-surface-subtle); }
.desktop-document-modes > button { display: inline-grid; place-items: center; width: 20px; height: 20px; padding: 0; border: 0; border-radius: 4px; background: transparent; color: var(--buddy-text-secondary); cursor: pointer; }
.desktop-document-modes > button:hover { color: var(--buddy-text-strong); }
.desktop-document-modes > button.is-active { background: var(--buddy-surface-base); color: var(--buddy-text-strong); font-weight: 600; }
.desktop-document-modes > button:focus-visible { outline: 2px solid var(--buddy-focus-ring); outline-offset: -1px; }
</style>
