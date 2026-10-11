<script setup lang="ts">
import type { WorkbenchSlot } from '@buddy-shared/workbench/workbenchUi'
import DesktopExtensionSurface from './DesktopExtensionSurface.vue'
import { useExtensionUiSurfaces } from './useExtensionUiSurfaces'

const props = defineProps<{ target: WorkbenchSlot }>()
defineSlots<{ default: () => unknown }>()
const { surfaces, selected } = useExtensionUiSurfaces(() => ({ kind: 'slot', target: props.target }))
</script>

<template>
  <div class="extension-slot min-w-0" :data-workbench-slot="target">
    <div v-for="surface in surfaces" :key="surface.input.viewId" class="relative min-w-0" :style="{ height: selected.includes(surface) ? `${surface.height}px` : '0px' }">
      <DesktopExtensionSurface :input="surface.input" :visible="selected.includes(surface)" silent class="extension-slot__surface" />
    </div>
    <slot v-if="!selected.length" />
  </div>
</template>

<style scoped lang="scss">
.extension-slot__surface { position: absolute; inset: 0; }
</style>
