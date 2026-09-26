<script setup lang="ts">
import type { ExtensionViewInput } from '@buddy-shared/extensions/extensionApi'
import type { WorkbenchSlot } from '@buddy-shared/workbench/workbenchUi'
import { computed, shallowRef, watch } from 'vue'
import { useWorkbenchUiScope } from '@/shared/ui/contributions/workbenchUiContext'
import { useExtensionContext } from '../extensionContext'
import DesktopExtensionSurface from './DesktopExtensionSurface.vue'

const props = defineProps<{ target: WorkbenchSlot }>()
defineSlots<{ default: () => unknown }>()
const { ui, views } = useExtensionContext()
const scope = useWorkbenchUiScope()
const providers = computed(() => ui.selected({ kind: 'slot', target: props.target }))
const inputs = shallowRef(new Map<string, ExtensionViewInput>())
watch(() => providers.value.map(({ plugin, placement }) => `${placement.id}:${plugin.revision}:${scope?.instanceId() ?? ''}`), (keys) => {
  inputs.value = new Map(keys.map((key, index) => {
    const { plugin, placement } = providers.value[index]!
    return [key, inputs.value.get(key) ?? { viewId: crypto.randomUUID(), extensionId: plugin.manifest.id, viewType: placement.view, placementId: placement.id, instanceId: scope?.instanceId(), resource: null, state: null, stateVersion: 0 }]
  }))
}, { immediate: true, flush: 'sync' })
const surfaces = computed(() => [...inputs.value.values()].map((input) => {
  const entry = views.surfaces.get(input.viewId)
  const provider = providers.value.find(provider => provider.placement.id === input.placementId)!
  return { input, height: provider.placement.height, ready: !!entry?.ready && entry.eligible && !entry.error && !['failed', 'blocked'].includes(provider.plugin.state) }
}))
</script>

<template>
  <div class="extension-slot" :data-workbench-slot="target">
    <div v-for="surface in surfaces" :key="surface.input.viewId" class="extension-slot__content" :style="{ height: surface.ready ? `${surface.height}px` : '0px' }">
      <DesktopExtensionSurface :input="surface.input" :visible="surface.ready" silent class="extension-slot__surface" />
    </div>
    <slot v-if="!surfaces.some(surface => surface.ready)" />
  </div>
</template>

<style scoped>
.extension-slot { min-width: 0; }
.extension-slot__content { position: relative; min-width: 0; }
.extension-slot__surface { position: absolute; inset: 0; }
</style>
