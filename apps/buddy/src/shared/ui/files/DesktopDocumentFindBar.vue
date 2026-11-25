<script setup lang="ts">
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { ChevronDown20Regular, ChevronUp20Regular, Dismiss20Regular } from '@vicons/fluent'
import { computed, nextTick, useTemplateRef, watch } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'

const props = defineProps<{ count: number, index: number, capped: boolean, focusToken: number, language: BuddyLocale }>()
const emit = defineEmits<{ next: [], previous: [], close: [], composing: [value: boolean] }>()
const query = defineModel<string>({ required: true })
const { t } = useBuddyI18n(() => props.language)
const input = useTemplateRef<HTMLInputElement>('input')
const empty = computed(() => !!query.value.trim() && props.count === 0)
const current = computed(() => props.count ? Math.min(props.index, props.count - 1) + 1 : 0)
const status = computed(() => {
  if (!query.value.trim())
    return ''
  if (!props.count)
    return t('desktop.context.findNone')
  return props.capped
    ? t('desktop.context.findCapped', { current: current.value })
    : t('desktop.context.findCount', { current: current.value, total: props.count })
})
const statusLabel = computed(() => {
  if (!query.value.trim())
    return undefined
  if (!props.count)
    return t('desktop.context.findStatusNone')
  return props.capped
    ? t('desktop.context.findStatusCapped', { current: current.value })
    : t('desktop.context.findStatus', { current: current.value, total: props.count })
})
watch(() => props.focusToken, () => {
  void nextTick(() => {
    input.value?.focus()
    input.value?.select()
  })
}, { flush: 'post' })
function onKeydown(event: KeyboardEvent) {
  if (event.isComposing)
    return
  if (event.key !== 'Enter')
    return
  event.preventDefault()
  emit(event.shiftKey ? 'previous' : 'next')
}
</script>

<template>
  <form class="desktop-document-find" :class="{ 'is-empty': empty }" role="search" data-testid="document-find" @submit.prevent>
    <input
      ref="input"
      v-model="query"
      class="desktop-document-find__input"
      type="text"
      autocomplete="off"
      spellcheck="false"
      data-testid="document-find-input"
      :placeholder="t('desktop.context.findPlaceholder')"
      :aria-label="t('desktop.context.findPlaceholder')"
      :aria-invalid="empty || undefined"
      @compositionstart="emit('composing', true)"
      @compositionend="emit('composing', false)"
      @keydown="onKeydown"
    >
    <span class="desktop-document-find__count" data-testid="document-find-count" aria-live="polite" :aria-label="statusLabel">{{ status }}</span>
    <button type="button" data-testid="document-find-previous" :aria-label="t('desktop.context.findPrevious')" :disabled="!count" @click="emit('previous')">
      <DesktopIcon :component="ChevronUp20Regular" :size="16" />
    </button>
    <button type="button" data-testid="document-find-next" :aria-label="t('desktop.context.findNext')" :disabled="!count" @click="emit('next')">
      <DesktopIcon :component="ChevronDown20Regular" :size="16" />
    </button>
    <button type="button" data-testid="document-find-close" :aria-label="t('desktop.context.findClose')" @click="emit('close')">
      <DesktopIcon :component="Dismiss20Regular" :size="16" />
    </button>
  </form>
</template>

<style scoped>
.desktop-document-find { position: absolute; z-index: 3; top: 8px; right: 12px; left: 12px; display: flex; align-items: center; gap: 4px; min-height: 32px; margin: 0; padding: 2px 4px 2px 8px; border: 1px solid var(--buddy-border-subtle); border-radius: 6px; background: var(--buddy-surface-raised); box-shadow: 0 8px 24px rgb(32 37 34 / 16%); }
.desktop-document-find.is-empty { border-color: var(--buddy-status-warning-text); }
.desktop-document-find:focus-within:not(.is-empty) { border-color: var(--buddy-focus-ring); }
.desktop-document-find__input { flex: 1; min-width: 0; border: 0; outline: 0; background: transparent; color: var(--buddy-text-primary); font: inherit; font-size: 12px; }
.desktop-document-find__input::placeholder { color: var(--buddy-text-muted); }
.desktop-document-find__count { flex: none; min-width: 3.5em; color: var(--buddy-text-muted); font-size: 11px; font-variant-numeric: tabular-nums; text-align: right; }
.desktop-document-find.is-empty .desktop-document-find__count { color: var(--buddy-status-warning-text); }
.desktop-document-find button { display: grid; flex: none; place-items: center; width: 22px; height: 22px; padding: 0; border: 0; border-radius: 4px; background: transparent; color: var(--buddy-text-secondary); cursor: pointer; }
.desktop-document-find button:hover:not(:disabled) { background: var(--buddy-state-hover); color: var(--buddy-text-primary); }
.desktop-document-find button:focus-visible { outline: 2px solid var(--buddy-focus-ring); outline-offset: -1px; }
.desktop-document-find button:disabled { color: var(--buddy-text-muted); cursor: default; opacity: 0.45; }
</style>
