<script setup lang="ts" generic="T extends string">
import { Checkmark16Regular } from '@vicons/fluent'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'

defineProps<{
  disabled?: boolean
  options: readonly { value: T, color: string, reset?: boolean }[]
}>()
const value = defineModel<T>({ required: true })
</script>

<template>
  <div class="desktop-color-palette grid grid-cols-[repeat(9,_24px)] grid-rows-[repeat(3,_24px)] justify-between gap-y-[5px]">
    <button
      v-for="option in options"
      :key="option.value"
      class="desktop-color-palette__swatch grid w-[24px] h-[24px] place-items-center p-0 border-1 border-solid border-transparent rounded-[6px] cursor-pointer disabled:cursor-default focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-focus focus-visible:outline-offset-[2px]"
      :class="{ 'is-selected': value === option.value, 'is-reset': option.reset }"
      :style="{ '--swatch-color': option.color }"
      type="button"
      :disabled="disabled"
      :aria-label="option.value"
      :data-color="option.value"
      :aria-pressed="value === option.value"
      @click="value = option.value"
    >
      <DesktopIcon v-if="value === option.value" class="desktop-color-palette__check" :component="Checkmark16Regular" :size="14" />
    </button>
  </div>
</template>

<style scoped lang="scss">
.desktop-color-palette {
  grid-auto-flow: column;
}

.desktop-color-palette__swatch {
  background: var(--swatch-color);
}

.desktop-color-palette__swatch.is-reset {
  border-color: var(--buddy-border-strong);
  background: linear-gradient(135deg, var(--buddy-surface-raised) 47%, var(--buddy-text-secondary) 48%, var(--buddy-text-secondary) 52%, var(--buddy-surface-raised) 53%);
}

.desktop-color-palette__swatch:not(:disabled):hover,
.desktop-color-palette__swatch.is-selected {
  box-shadow: 0 0 0 1px var(--buddy-surface-raised), 0 0 0 2px var(--swatch-color);
}

.desktop-color-palette__check {
  border-radius: 3px;
  background: var(--buddy-surface-raised);
  color: var(--buddy-text-strong);
}
</style>
