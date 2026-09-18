<script setup lang="ts">
import type { ExtensionViewInput } from '@buddy-shared/extensions/extensionApi'
import type { WorkbenchView } from '@/workbench/common/workbench'
import { extensionViewInputSchema } from '@buddy-shared/extensions/extensionApi'
import { computed } from 'vue'
import DesktopExtensionSurface from './DesktopExtensionSurface.vue'

const props = defineProps<{ view: WorkbenchView, visible: boolean }>()
const input = computed<ExtensionViewInput | null>(() => {
  const parsed = extensionViewInputSchema.safeParse({ viewId: props.view.id, extensionId: props.view.resource.data.extensionId, viewType: props.view.type, resource: props.view.resource.data.resource ?? null, state: props.view.state.value ?? {}, stateVersion: props.view.state.version ?? 0 })
  return parsed.success ? parsed.data : null
})
</script>

<template>
  <DesktopExtensionSurface :input="input" :visible="visible" />
</template>
