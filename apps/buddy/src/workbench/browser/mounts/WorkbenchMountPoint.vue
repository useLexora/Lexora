<script setup lang="ts">
import type { WorkbenchMountTarget } from '@buddy-shared/workbench/workbenchUi'
import { useTemplateRef, watch } from 'vue'
import { useWorkbench } from '../workbenchContext'

const props = defineProps<{ target: WorkbenchMountTarget, instanceId?: string }>()
const { registerMountPoint } = useWorkbench()
const element = useTemplateRef<HTMLElement>('element')
watch([element, () => props.target, () => props.instanceId], ([element, target, instanceId], _, cleanup) => {
  if (element)
    cleanup(registerMountPoint(target, element, instanceId))
})
</script>

<template>
  <div ref="element" class="workbench-mount-point" :data-mount-point="target" :data-mount-instance="instanceId">
    <div class="workbench-mount-point__content">
      <slot />
    </div>
  </div>
</template>

<style scoped>
.workbench-mount-point { position: relative; display: flex; flex: 1; flex-direction: column; min-width: 0; min-height: 0; overflow: hidden; }
.workbench-mount-point__content { position: relative; display: flex; flex: 1; flex-direction: column; min-width: 0; min-height: 0; }
</style>
