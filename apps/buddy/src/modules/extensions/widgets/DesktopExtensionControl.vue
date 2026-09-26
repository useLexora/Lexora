<script setup lang="ts">
import type { ExtensionViewInput } from '@buddy-shared/extensions/extensionApi'
import type { WorkbenchControlProps } from '@/shared/ui/contributions/workbenchUiContext'
import { computed, shallowRef, useTemplateRef, watch } from 'vue'
import { useWorkbenchUiScope } from '@/shared/ui/contributions/workbenchUiContext'
import { ControlBinding } from '@/workbench/browser/controls/ControlBinding'
import { useExtensionContext } from '../extensionContext'
import DesktopExtensionSurface from './DesktopExtensionSurface.vue'

const props = defineProps<WorkbenchControlProps>()
const emit = defineEmits<{ change: [value: string], dismiss: [] }>()
defineSlots<{ default: () => unknown }>()
const { views, ui } = useExtensionContext()
const scope = useWorkbenchUiScope()
const root = useTemplateRef<HTMLElement>('root')
const provider = computed(() => ui.selected({ kind: 'control', target: props.target })[0])
const input = shallowRef<ExtensionViewInput | null>(null)
function createInput() {
  const contribution = provider.value
  input.value = contribution ? { viewId: crypto.randomUUID(), extensionId: contribution.plugin.manifest.id, viewType: contribution.placement.view, placementId: contribution.placement.id, instanceId: scope?.instanceId(), resource: null, state: null, stateVersion: 0 } : null
}
watch([() => provider.value?.placement.id, () => provider.value?.plugin.revision, () => scope?.instanceId()], createInput, { immediate: true, flush: 'sync' })
const entry = computed(() => input.value ? views.surfaces.get(input.value.viewId) : null)
const ready = computed(() => !!entry.value?.ready && entry.value.eligible && !entry.value.error && !['failed', 'blocked'].includes(provider.value?.plugin.state ?? 'failed'))
const binding = new ControlBinding(() => document.visibilityState === 'visible' && !!root.value?.getClientRects().length && getComputedStyle(root.value).visibility !== 'hidden' && !root.value.closest('[inert], [hidden]') && ready.value, value => emit('change', value))
watch(() => [props.contextKey, props.value, props.disabled, entry.value?.eligible, JSON.stringify(props.options)], () => {
  binding.update(props.contextKey, { value: props.value, options: props.options, disabled: props.disabled || entry.value?.eligible === false })
}, { immediate: true, flush: 'sync' })
const control = { dismiss: () => emit('dismiss'), snapshot: () => binding.snapshot.value, propose: binding.propose.bind(binding) }
const height = computed(() => provider.value?.placement.kind === 'control' ? provider.value.placement.height : 64)
</script>

<template>
  <div ref="root" class="extension-control" :data-workbench-control="target">
    <div class="extension-control__content" :style="ready ? { height: `${height}px` } : undefined">
      <DesktopExtensionSurface v-if="input" :input="input" :visible="ready" :control="control" silent class="extension-control__surface" />
      <slot v-if="!ready" />
    </div>
  </div>
</template>

<style scoped>
.extension-control { min-width: 0; }
.extension-control__content { position: relative; min-height: 32px; }
.extension-control__surface { position: absolute; inset: 0; }
</style>
