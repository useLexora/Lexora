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
  <div ref="element" class="workbench-mount-point relative flex flex-1 flex-col min-w-0 min-h-0 overflow-hidden" :data-mount-point="target" :data-mount-instance="instanceId">
    <div class="relative flex flex-1 flex-col min-w-0 min-h-0">
      <slot />
    </div>
  </div>
</template>
