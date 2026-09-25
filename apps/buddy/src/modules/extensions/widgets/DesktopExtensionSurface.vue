<script setup lang="ts">
import type { ExtensionViewInput } from '@buddy-shared/extensions/extensionApi'
import type { ExtensionControlBinding, ExtensionSurface } from './useExtensionViews'
import { NButton } from 'naive-ui'
import { computed, onScopeDispose, useTemplateRef, watch } from 'vue'
import { useExtensionContext } from '../extensionContext'
import { extensionLabels } from '../extensionLabels'

const props = defineProps<{ input: ExtensionViewInput | null, visible: boolean, silent?: boolean, control?: ExtensionControlBinding, mount?: ExtensionSurface['mount'] }>()
const { state, views, language } = useExtensionContext()
const labels = computed(() => extensionLabels(language.value))
const surface = useTemplateRef<HTMLElement>('surface')
const entry = computed(() => props.input ? views.surfaces.get(props.input.viewId) : null)
watch(() => props.input?.viewId, (next, previous) => {
  if (previous && next !== previous)
    views.hide(previous)
})
watch([() => props.input, surface, () => props.visible, () => props.control, () => props.mount], ([input, element, visible]) => {
  if (input && element)
    views.show(input, element, visible, { control: props.control, mount: props.mount })
}, { flush: 'post' })
onScopeDispose(() => {
  if (props.input)
    views.hide(props.input.viewId)
})
function retry() {
  if (props.input)
    void state.api.restart(props.input.extensionId).catch(() => {})
}
</script>

<template>
  <div ref="surface" class="extension-surface" :data-extension-surface="input?.viewId">
    <div v-if="!silent && (!input || entry?.error)" class="extension-surface__status" role="status">
      <p>{{ labels.failed }}</p>
      <code>{{ entry?.error }}</code>
      <NButton v-if="input" size="small" @click="retry">
        {{ labels.retry }}
      </NButton>
    </div>
    <p v-else-if="!silent && entry?.eligible !== false && !entry?.session" class="extension-surface__status" role="status">
      {{ labels.loading }}
    </p>
  </div>
</template>

<style scoped>
.extension-surface { height: 100%; width: 100%; min-height: 0; position: relative; }
.extension-surface__status { display: grid; justify-items: center; align-content: center; gap: 12px; height: 100%; margin: 0; color: var(--buddy-text-secondary); font-size: 13px; }
.extension-surface__status p { margin: 0; }
.extension-surface__status code { font-size: 11px; }
</style>
