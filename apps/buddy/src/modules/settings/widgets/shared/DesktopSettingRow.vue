<script setup lang="ts">
import { computed, useId } from 'vue'

const props = defineProps<{ label: string, description?: string, toggle?: boolean, disabled?: boolean, error?: string | null }>()
defineSlots<{
  default: (props: { labelId: string, controlAttrs: { 'aria-labelledby': string, 'aria-describedby': string | undefined } }) => unknown
  hint?: () => unknown
}>()
const labelId = useId()
const descriptionId = `${labelId}-description`
const errorId = `${labelId}-error`
const controlAttrs = computed(() => ({
  'aria-labelledby': labelId,
  'aria-describedby': [props.description && descriptionId, props.error && errorId].filter(Boolean).join(' ') || undefined,
}))
</script>

<template>
  <div class="desktop-settings-row grid min-h-[var(--setting-row-height,4rem)] items-center gap-8 border-b border-b-solid border-b-border px-[var(--setting-row-px,0.9rem)] py-[var(--setting-row-py,0.75rem)] last:border-b-0 grid-cols-[minmax(var(--setting-label-min,0px),1fr)_minmax(var(--setting-control-min,10rem),var(--setting-control-max,19rem))]">
    <div class="grid min-w-0 gap-[var(--setting-copy-gap,0.25rem)]">
      <strong :id="labelId" class="text-[0.8rem] font-600" :class="disabled ? 'text-disabled' : 'text-fg'">{{ label }}</strong>
      <small v-if="description" :id="descriptionId" class="text-[length:var(--setting-description-size,0.7rem)] leading-[var(--setting-description-leading,1.5)]" :class="disabled ? 'text-disabled' : 'text-muted'">{{ description }}</small>
      <slot name="hint" />
    </div>
    <div class="desktop-settings-row__control min-w-0 items-center gap-[0.55rem]" :class="toggle ? 'is-toggle flex flex-wrap justify-end' : 'grid grid-cols-[minmax(0,1fr)_auto]'">
      <slot :label-id="labelId" :control-attrs="controlAttrs" />
      <small v-if="error" :id="errorId" class="col-span-full basis-full text-[0.7rem] text-danger leading-[1.5]" :class="{ 'text-right': toggle }" role="alert">{{ error }}</small>
    </div>
  </div>
</template>

<style scoped lang="scss">
.desktop-settings-row {
  @container (max-width: 560px) {
    grid-template-columns: minmax(0, 1fr);
    gap: 0.7rem;

    .is-toggle {
      justify-content: start;
    }
  }
}
</style>
