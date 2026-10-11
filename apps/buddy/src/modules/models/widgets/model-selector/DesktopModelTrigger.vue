<script setup lang="ts">
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { DismissCircle16Filled, Flash20Filled } from '@vicons/fluent'
import { computed } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import ModelIcon from '@/shared/ui/icon/ModelIcon.vue'

const props = defineProps<{
  language: BuddyLocale
  modelLabel: string
  selectedEffortLabel: string
  isEffortUnavailable: boolean
  isFastMode: boolean
  isOpen: boolean
  canOpen: boolean
  canClearModel: boolean
  surface: 'compact' | 'field'
}>()
const emit = defineEmits<{ toggle: [], clear: [] }>()
const { t } = useBuddyI18n(() => props.language)
const modelTriggerLabel = computed(() => {
  if (!props.selectedEffortLabel)
    return props.modelLabel
  const effort = props.isEffortUnavailable
    ? `${props.selectedEffortLabel} (${t('common.unavailable')})`
    : props.selectedEffortLabel
  return `${props.modelLabel} · ${effort}`
})
</script>

<template>
  <div
    class="desktop-model-selector__control relative min-w-0"
    :class="{ 'is-clearable': canClearModel }"
  >
    <button
      class="desktop-model-selector__trigger ui-focus-ring transition-state-colors inline-flex min-w-0 items-center gap-[0.35rem] cursor-pointer text-[0.78rem] py-0 disabled:(cursor-not-allowed opacity-50)"
      :class="[
        surface === 'field'
          ? 'is-field w-full max-w-none h-9 border border-solid border-border rounded-2 bg-raised pl-[0.7rem]'
          : ['is-compact max-w-[min(22rem,44vw)] h-control border-0 rounded-control pl-[0.55rem]', isOpen ? 'bg-accent-surface text-strong' : 'bg-transparent enabled:hover:not-active:(bg-hover text-strong) enabled:active:(bg-pressed text-strong) focus-visible:(bg-hover text-strong)'],
        { 'is-fast': isFastMode },
        surface === 'field' || !isOpen ? (isFastMode ? 'text-accent-text' : 'text-muted') : '',
        canClearModel ? 'pr-8' : (surface === 'field' ? 'pr-[0.55rem]' : 'pr-[0.45rem]'),
      ]"
      type="button"
      aria-haspopup="menu"
      :aria-label="modelTriggerLabel"
      :aria-expanded="isOpen"
      :disabled="!canOpen"
      @click="emit('toggle')"
    >
      <DesktopIcon class="desktop-model-selector__compact-icon hidden flex-none" :component="ModelIcon" :size="18" />
      <DesktopIcon v-if="isFastMode" class="desktop-model-selector__flash flex-none text-gold" :component="Flash20Filled" />
      <span class="desktop-model-selector__model min-w-0 overflow-hidden font-650 text-ellipsis whitespace-nowrap">
        {{ modelLabel }}
      </span>
      <span v-if="selectedEffortLabel" class="desktop-model-selector__separator flex-none text-muted">·</span>
      <span v-if="selectedEffortLabel" class="desktop-model-selector__effort flex-none text-muted">
        {{ selectedEffortLabel }}{{ isEffortUnavailable ? ` (${t('common.unavailable')})` : '' }}
      </span>
    </button>
    <button
      v-if="canClearModel"
      class="desktop-model-selector__clear absolute top-[50%] right-1 z-1 grid w-6 h-6 place-items-center border-0 rounded-[0.375rem] bg-transparent text-muted cursor-pointer opacity-0 p-0 pointer-events-none -translate-y-1/2 transition-opacity duration-80 ease-[ease] hover:(bg-hover text-muted outline-0) focus-visible:(bg-hover text-muted outline-0)"
      type="button"
      :aria-label="t('desktop.chat.clearModel')"
      @click="emit('clear')"
    >
      <DesktopIcon :component="DismissCircle16Filled" />
    </button>
  </div>
</template>

<style scoped lang="scss">
.desktop-model-selector__control {
  &.is-clearable:hover .desktop-model-selector__clear,
  &.is-clearable:has(.desktop-model-selector__clear:focus-visible) .desktop-model-selector__clear {
    opacity: 1;
    pointer-events: auto;
  }
}

@media (max-width: 680px) {
  .desktop-model-selector__trigger {
    max-width: 50vw;
  }
}
</style>
