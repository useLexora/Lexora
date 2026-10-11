<script setup lang="ts">
import type { BuddyThinkingLevel } from '@buddy-shared/conversation/modelSelection'
import type { ReasoningSelectorOption } from './typing'

import type { BuddyLocale } from '@/i18n/buddyI18n'
import { Checkmark16Regular } from '@vicons/fluent'
import { useBuddyI18n } from '@/i18n/buddyI18n'

import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'

const props = defineProps<{
  language: BuddyLocale
  options: ReadonlyArray<ReasoningSelectorOption>
  selectedEffort: BuddyThinkingLevel | null
}>()

const emit = defineEmits<{
  select: [value: BuddyThinkingLevel]
}>()

const { t } = useBuddyI18n(() => props.language)
</script>

<template>
  <section class="desktop-reasoning-picker grid overflow-hidden w-54 max-h-[min(24rem,_58vh)] border-1 border-solid border-border rounded-menu bg-raised shadow-overlay" role="menu">
    <span class="text-muted text-[0.7rem] leading-[1.35] pt-[0.65rem] pr-[1.05rem] pb-[0.3rem] pl-[1.05rem]">{{ t('desktop.chat.effort') }}</span>
    <div class="desktop-reasoning-picker__options overflow-x-hidden overflow-y-auto grid min-h-0 content-start gap-[0.15rem] pt-0 pr-2 pb-2 pl-2">
      <template v-for="(option, index) in options" :key="option.value">
        <button
          class="desktop-reasoning-picker__item ui-menu-option min-h-[2.15rem] gap-[0.65rem] px-[0.55rem] py-[0.4rem]"
          type="button"
          role="menuitemradio"
          :aria-checked="selectedEffort === option.value"
          @click="emit('select', option.value)"
        >
          <strong class="min-w-0 truncate text-[0.78rem] font-650">{{ option.label }}</strong>
          <DesktopIcon v-if="selectedEffort === option.value" class="flex-none" :component="Checkmark16Regular" />
        </button>
        <span
          v-if="option.value === 'off' && index < options.length - 1"
          class="h-[1px] my-1 mx-[0.15rem] bg-border"
        />
      </template>
    </div>
  </section>
</template>
