<script setup lang="ts">
import type { Component } from 'vue'
import type { WorkbenchView } from '@/workbench/common/workbench'
import { computed } from 'vue'
import { useWorkbench } from '@/workbench/browser/workbenchContext'

const props = defineProps<{ view: WorkbenchView, visible: boolean }>()
const { controller, revision, labels } = useWorkbench()
const factory = computed(() => {
  void revision.value
  return controller.registry.views.get(props.view.type)?.factory as Component | undefined
})
</script>

<template>
  <component :is="factory" v-if="factory" :view="view" :visible="visible" />
  <div v-else role="status">
    {{ labels.missing }}
  </div>
</template>
