<script setup lang="ts">
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { ChevronLeft16Regular, ChevronRight16Regular, Flash20Filled } from '@vicons/fluent'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'

const props = defineProps<{
  language: BuddyLocale
  modelLabel: string
  selectedEffortLabel: string
  isEffortUnavailable: boolean
  hasReasoning: boolean
  supportsFastMode: boolean
  isFastMode: boolean
  secondaryPanel: 'model' | 'reasoning' | null
}>()
const emit = defineEmits<{ back: [], panel: [panel: 'model' | 'reasoning'], toggleFast: [] }>()
const { t } = useBuddyI18n(() => props.language)
</script>

<template>
  <section
    class="desktop-model-selector__panel desktop-model-selector__panel--advanced grid gap-menu-gap flex-none w-[min(17rem,calc(100vw_-_2rem))] overflow-hidden border border-solid border-border rounded-menu bg-raised shadow-overlay p-[0.375rem]"
    role="menu"
  >
    <button class="desktop-model-selector__back inline-flex min-w-12 h-7 items-center justify-start justify-self-start gap-0 border-0 rounded-menu-item bg-transparent text-muted cursor-pointer text-[0.74rem] leading-[1] py-1 pl-[0.15rem] pr-[0.45rem] hover:(bg-hover text-strong outline-0) focus-visible:(bg-hover text-strong outline-0)" type="button" @click="emit('back')">
      <DesktopIcon class="flex-none mx-[-0.125rem] [transform:translateY(-0.04rem)]" :size="16" :component="ChevronLeft16Regular" />
      <span>{{ t('desktop.chat.advanced') }}</span>
    </button>
    <span class="h-[1px] mt-0 mr-[0.2rem] mb-[0.125rem] ml-[0.2rem] bg-border" />
    <button
      class="desktop-model-selector__item ui-menu-item"
      :class="{ 'is-active bg-hover outline-0': secondaryPanel === 'model' }"
      type="button"
      @click="emit('panel', 'model')"
    >
      <span class="flex-none text-[0.76rem] whitespace-nowrap">{{ t('desktop.chat.model') }}</span>
      <strong class="truncate text-muted text-[0.76rem] font-500 text-right">{{ modelLabel }}</strong>
      <DesktopIcon class="text-muted" :component="ChevronRight16Regular" />
    </button>
    <button
      v-if="hasReasoning"
      class="desktop-model-selector__item ui-menu-item"
      :class="{ 'is-active bg-hover outline-0': secondaryPanel === 'reasoning' }"
      type="button"
      @click="emit('panel', 'reasoning')"
    >
      <span class="flex-none text-[0.76rem] whitespace-nowrap">{{ t('desktop.chat.effort') }}</span>
      <strong class="truncate text-muted text-[0.76rem] font-500 text-right">{{ selectedEffortLabel }}{{ isEffortUnavailable ? ` (${t('common.unavailable')})` : '' }}</strong>
      <DesktopIcon class="text-muted" :component="ChevronRight16Regular" />
    </button>
    <button
      v-if="supportsFastMode"
      class="desktop-model-selector__item ui-menu-item"
      :class="{ 'is-fast': isFastMode }"
      type="button"
      role="menuitemcheckbox"
      :aria-checked="isFastMode"
      @click="emit('toggleFast')"
    >
      <span class="flex-none text-[0.76rem] whitespace-nowrap">{{ t('desktop.chat.speed') }}</span>
      <strong class="truncate text-muted text-[0.76rem] font-500 text-right">{{ t(isFastMode ? 'desktop.chat.fastMode' : 'desktop.chat.standardSpeed') }}</strong>
      <DesktopIcon :class="isFastMode ? 'text-gold' : 'text-muted'" :component="Flash20Filled" />
    </button>
  </section>
</template>
