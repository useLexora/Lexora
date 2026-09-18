<script setup lang="ts">
import type { ExtensionViewInput } from '@buddy-shared/extensions/extensionApi'
import { shallowRef, watch } from 'vue'
import { useExtensionContext } from '../extensionContext'
import DesktopExtensionSurface from './DesktopExtensionSurface.vue'

const { state } = useExtensionContext()
const inputs = shallowRef<ExtensionViewInput[]>([])
watch(state.installed, (installed) => {
  inputs.value = installed.filter(item => item.enabled && item.compatible && !['failed', 'blocked'].includes(item.state) && item.manifest.permissions.windowEffects)
    .flatMap(item => item.manifest.contributes.views.filter(view => view.location === 'window-overlay').map(view => inputs.value.find(input => input.extensionId === item.manifest.id && input.viewType === view.id)
      ?? { viewId: crypto.randomUUID(), extensionId: item.manifest.id, viewType: view.id, state: null, stateVersion: view.stateVersion, resource: null }))
}, { immediate: true })
</script>

<template>
  <div class="extension-overlays" aria-hidden="true">
    <DesktopExtensionSurface v-for="input in inputs" :key="input.viewId" :input="input" visible silent class="extension-overlays__surface" />
  </div>
</template>

<style scoped>
.extension-overlays { position: fixed; inset: 0; pointer-events: none; }
.extension-overlays__surface { position: absolute; inset: 0; }
</style>
