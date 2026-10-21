<script setup lang="ts">
import { computed, useId } from 'vue'

const props = defineProps<{ label: string, description?: string, error?: string | null, toggle?: boolean }>()
const labelId = useId()
const descriptionId = `${labelId}-description`
const errorId = `${labelId}-error`
const controlAttrs = computed(() => ({
  'aria-labelledby': labelId,
  'aria-describedby': [props.description && descriptionId, props.error && errorId].filter(Boolean).join(' ') || undefined,
}))
</script>

<template>
  <div class="grid min-w-0 gap-1">
    <span :id="labelId" class="sr-only">{{ label }}</span>
    <span v-if="description" :id="descriptionId" class="sr-only">{{ description }}</span>
    <slot :label-id="labelId" :control-attrs="controlAttrs" />
    <slot name="hint" />
    <small v-if="error" :id="errorId" class="text-danger text-[12px] leading-[1.5]" role="alert">{{ error }}</small>
  </div>
</template>
