<script setup lang="ts">
import type { ExtensionViewInput } from '@buddy-shared/extensions/extensionApi'
import type { WorkbenchView } from '@/workbench/common/workbench'
import { extensionViewInputSchema } from '@buddy-shared/extensions/extensionApi'
import { workbenchMountKey } from '@buddy-shared/workbench/workbenchUi'
import { computed } from 'vue'
import { useWorkbench } from '@/workbench/browser/workbenchContext'
import DesktopExtensionSurface from './DesktopExtensionSurface.vue'

const props = defineProps<{ view: WorkbenchView, visible: boolean }>()
const { controller, mountPoints, revision } = useWorkbench()
const mount = computed(() => {
  void revision.value
  const placement = props.view.placement ? controller.registry.placements.get(props.view.placement) : null
  const target = props.view.presentation?.target ?? placement?.target
  const element = target ? mountPoints.value.get(workbenchMountKey(target, props.view.mountInstanceId)) : null
  return target && element ? { target, element, instanceId: props.view.mountInstanceId } : null
})
const input = computed<ExtensionViewInput | null>(() => {
  const parsed = extensionViewInputSchema.safeParse({ viewId: props.view.id, interactionId: props.view.interactionId, instanceId: props.view.mountInstanceId, extensionId: props.view.resource.data.extensionId, viewType: props.view.type, placementId: props.view.resource.data.placementId, resource: props.view.resource.data.resource ?? null, state: props.view.state.value ?? {}, stateVersion: props.view.state.version ?? 0 })
  return parsed.success ? parsed.data : null
})
</script>

<template>
  <DesktopExtensionSurface :input="input" :visible="visible" :mount="mount" />
</template>
