<script setup lang="ts">
import type { ExtensionViewInput } from '@buddy-shared/extensions/extensionApi'
import type { WorkbenchControlProps } from '@/shared/ui/contributions/workbenchUiContext'
import { computed, shallowRef, useTemplateRef, watch } from 'vue'
import { ControlBinding } from '@/workbench/browser/controls/ControlBinding'
import { useExtensionContext } from '../extensionContext'
import DesktopExtensionSurface from './DesktopExtensionSurface.vue'

const props = defineProps<WorkbenchControlProps>()
const emit = defineEmits<{ change: [value: string], dismiss: [] }>()
defineSlots<{ default: () => unknown }>()
const { state, views, controls, language } = useExtensionContext()
const root = useTemplateRef<HTMLElement>('root')
const providers = computed(() => state.installed.value.filter(plugin => plugin.enabled && plugin.compatible)
  .flatMap(plugin => plugin.manifest.contributes.placements.filter(placement => placement.kind === 'control' && placement.target === props.target)
    .map(placement => ({ plugin, placement })))
  .sort((left, right) => left.placement.id.localeCompare(right.placement.id)))
const selected = computed(() => controls.selection.value[props.target] ?? '')
const provider = computed(() => providers.value.find(provider => provider.placement.id === selected.value))
const input = shallowRef<ExtensionViewInput | null>(null)
function choose(id: string) {
  views.retryControl(id)
  if (id !== selected.value)
    controls.select(props.target, id)
}
function createInput() {
  const contribution = provider.value
  input.value = contribution ? { viewId: crypto.randomUUID(), extensionId: contribution.plugin.manifest.id, viewType: contribution.placement.view, placementId: contribution.placement.id, resource: null, state: null, stateVersion: 0 } : null
}
watch([() => provider.value?.placement.id, () => provider.value?.plugin.revision], createInput, { immediate: true, flush: 'sync' })
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
    <div v-if="providers.length || selected" class="extension-control__choice">
      <select :value="selected" :aria-label="language === 'en-US' ? 'Reasoning control style' : '思考等级样式'" @change="choose(($event.target as HTMLSelectElement).value)">
        <option value="">
          {{ language === 'en-US' ? 'Built-in' : '内置' }}
        </option>
        <option v-if="selected && !provider" :value="selected" disabled>
          {{ language === 'en-US' ? 'Unavailable' : '暂不可用' }}
        </option>
        <option v-for="item in providers" :key="item.placement.id" :value="item.placement.id">
          {{ item.plugin.manifest.name }}
        </option>
      </select>
      <span v-if="selected && !ready" role="status">{{ language === 'en-US' ? 'Using built-in control' : '使用内置控件' }}</span>
    </div>
    <div class="extension-control__content" :style="ready ? { height: `${height}px` } : undefined">
      <DesktopExtensionSurface v-if="input" :input="input" :visible="ready" :control="control" silent class="extension-control__surface" />
      <slot v-if="!ready" />
    </div>
  </div>
</template>

<style scoped>
.extension-control { min-width: 0; }
.extension-control__choice { display: flex; justify-content: flex-end; align-items: center; gap: 6px; margin-bottom: 6px; font-size: 11px; color: var(--buddy-text-secondary); }
.extension-control__choice select { min-width: 0; max-width: 70%; border: 1px solid var(--buddy-border-subtle); border-radius: 4px; background: var(--buddy-surface-base); color: var(--buddy-text-secondary); font: inherit; padding: 2px 4px; }
.extension-control__content { position: relative; min-height: 32px; }
.extension-control__surface { position: absolute; inset: 0; }
</style>
