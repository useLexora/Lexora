<script setup lang="ts">
import type { WorkbenchView } from '@/workbench/common/workbench'
import { computed } from 'vue'
import { useWorkbench } from '@/workbench/browser/workbenchContext'
import { useDesktopWorkbenchContext } from './desktopWorkbenchContext'

const props = defineProps<{ view: WorkbenchView, visible: boolean }>()
const { controller, revision, labels } = useWorkbench()
const { renderers } = useDesktopWorkbenchContext()
const factory = computed(() => {
  void revision.value
  const descriptor = controller.registry.views.get(props.view.type)
  return descriptor ? renderers.resolve(descriptor.renderer) : undefined
})
</script>

<template>
  <component :is="factory" v-if="factory" :view="view" :visible="visible" />
  <div v-else role="status">
    {{ labels.missing }}
  </div>
</template>
