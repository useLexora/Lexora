<script setup lang="ts">
import type { WorkbenchMountTarget } from '@buddy-shared/workbench/workbenchUi'
import { useTemplateRef, watch } from 'vue'
import { useWorkbench } from '../workbenchContext'

const props = defineProps<{ target: WorkbenchMountTarget }>()
const { registerMountPoint } = useWorkbench()
const element = useTemplateRef<HTMLElement>('element')
watch([element, () => props.target], ([element, target], _, cleanup) => {
  if (element)
    cleanup(registerMountPoint(target, element))
})
</script>

<template>
  <div ref="element" class="workbench-mount-point" :data-mount-point="target">
    <div class="workbench-mount-point__content">
      <slot />
    </div>
  </div>
</template>

<style scoped>
.workbench-mount-point { position: relative; display: flex; flex: 1; flex-direction: column; min-width: 0; min-height: 0; overflow: hidden; }
.workbench-mount-point__content { display: flex; flex: 1; flex-direction: column; min-width: 0; min-height: 0; }
</style>
