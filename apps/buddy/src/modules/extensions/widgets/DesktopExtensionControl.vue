<script setup lang="ts">
import type { WorkbenchControlProps } from '@/shared/ui/contributions/workbenchUiContext'
import { computed, useTemplateRef, watch } from 'vue'
import { ControlBinding } from '@/workbench/browser/controls/ControlBinding'
import DesktopExtensionSurface from './DesktopExtensionSurface.vue'
import { useExtensionUiSurfaces } from './useExtensionUiSurfaces'

const props = defineProps<WorkbenchControlProps>()
const emit = defineEmits<{ change: [value: string], dismiss: [] }>()
defineSlots<{ default: () => unknown }>()
const root = useTemplateRef<HTMLElement>('root')
const { surfaces, selected } = useExtensionUiSurfaces(() => ({ kind: 'control', target: props.target }))
const ready = computed(() => !!selected.value.length)
const binding = new ControlBinding(() => document.visibilityState === 'visible' && !!root.value?.getClientRects().length && getComputedStyle(root.value).visibility !== 'hidden' && !root.value.closest('[inert], [hidden]') && ready.value, value => emit('change', value))
watch(() => [props.contextKey, props.value, props.disabled, selected.value[0]?.input.viewId, JSON.stringify(props.options)], () => {
  binding.update(JSON.stringify([props.contextKey, selected.value[0]?.input.viewId]), { value: props.value, options: props.options, disabled: props.disabled || !ready.value })
}, { immediate: true, flush: 'sync' })
const control = { dismiss: () => emit('dismiss'), snapshot: () => binding.snapshot.value, propose: binding.propose.bind(binding) }
const height = computed(() => selected.value[0]?.height ?? 64)
</script>

<template>
  <div ref="root" class="extension-control min-w-0" :data-workbench-control="target">
    <div class="relative min-h-[32px]" :style="ready ? { height: `${height}px` } : undefined">
      <DesktopExtensionSurface v-for="surface in surfaces" :key="surface.input.viewId" :input="surface.input" :visible="selected.includes(surface)" :control="control" silent class="extension-control__surface" />
      <slot v-if="!ready" />
    </div>
  </div>
</template>

<style scoped lang="scss">
.extension-control__surface { position: absolute; inset: 0; }
</style>
