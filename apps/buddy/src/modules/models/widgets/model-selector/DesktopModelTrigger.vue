<script setup lang="ts">
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { DismissCircle16Filled, Flash20Filled, Warning16Regular } from '@vicons/fluent'
import { NTooltip } from 'naive-ui'
import { computed } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import ProviderIcon from '@/shared/ui/icon/ProviderIcon.vue'

const props = defineProps<{
  language: BuddyLocale
  modelLabel: string
  providerId: string
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
    <NTooltip :disabled="isOpen">
      <template #trigger>
        <button
          class="desktop-model-selector__trigger ui-focus-ring transition-state-colors inline-flex min-w-0 items-center gap-[0.35rem] cursor-pointer text-[0.78rem] py-0 disabled:(cursor-not-allowed opacity-50)"
          :class="[
            surface === 'field'
              ? 'is-field w-full max-w-none h-9 border border-solid border-border rounded-2 bg-raised pl-[0.7rem]'
              : ['is-compact h-control border-0 rounded-control pl-[0.55rem]', isOpen ? 'bg-accent-surface text-strong' : 'bg-transparent enabled:hover:not-active:(bg-hover text-strong) enabled:active:(bg-pressed text-strong) focus-visible:(bg-hover text-strong)'],
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
          <ProviderIcon class="desktop-model-selector__compact-icon flex-none" :provider-id="providerId" />
          <DesktopIcon v-if="isFastMode" class="desktop-model-selector__flash flex-none text-gold" :component="Flash20Filled" />
          <DesktopIcon v-if="isEffortUnavailable" class="desktop-model-selector__warning flex-none text-warning" :component="Warning16Regular" />
          <span class="desktop-model-selector__model min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
            {{ modelLabel }}
          </span>
          <span v-if="selectedEffortLabel" class="desktop-model-selector__separator flex-none text-muted">·</span>
          <span v-if="selectedEffortLabel" class="desktop-model-selector__effort flex-none text-muted">
            {{ selectedEffortLabel }}{{ isEffortUnavailable ? ` (${t('common.unavailable')})` : '' }}
          </span>
        </button>
      </template>
      {{ modelTriggerLabel }}
    </NTooltip>
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
  &.is-clearable {
    --model-trigger-padding-right: 2rem;
  }

  &.is-clearable:hover .desktop-model-selector__clear,
  &.is-clearable:has(.desktop-model-selector__clear:focus-visible) .desktop-model-selector__clear {
    opacity: 1;
    pointer-events: auto;
  }
}

.desktop-model-selector__compact-icon {
  display: var(--composer-model-icon-display, none);
  width: 18px;
  height: 18px;
  color: inherit;
}

.desktop-model-selector__trigger.is-compact {
  position: relative;
  width: var(--composer-model-width, auto);
  max-width: var(--composer-model-max-width, 22rem);
  justify-content: center;
  gap: var(--composer-model-gap, 0.35rem);
  padding-left: var(--composer-model-padding, 0.55rem);
  padding-right: var(--composer-model-padding, var(--model-trigger-padding-right, 0.45rem));
  font-size: var(--composer-toolbar-font-size, 0.78rem);
}

.desktop-model-selector__model {
  display: var(--composer-model-label-display, inline);
  font-weight: var(--composer-model-font-weight, 650);
}

.desktop-model-selector__separator,
.desktop-model-selector__effort {
  display: var(--composer-effort-display, inline);
  font-size: var(--composer-effort-font-size, inherit);
  white-space: nowrap;
}

.desktop-model-selector__flash,
.desktop-model-selector__warning {
  position: var(--composer-model-badge-position, static);
  inset: var(--composer-model-badge-inset, auto);
  font-size: var(--composer-model-badge-size, 1em);
}
</style>
