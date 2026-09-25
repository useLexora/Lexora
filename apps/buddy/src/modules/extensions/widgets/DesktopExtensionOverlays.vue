<script setup lang="ts">
import type { ExtensionViewInput } from '@buddy-shared/extensions/extensionApi'
import { onScopeDispose, shallowRef, watch } from 'vue'
import { useExtensionContext } from '../extensionContext'
import DesktopExtensionSurface from './DesktopExtensionSurface.vue'

const { state, views, anchors } = useExtensionContext()
const inputs = shallowRef<ExtensionViewInput[]>([])
watch(state.installed, (installed) => {
  inputs.value = installed.filter(item => item.enabled && item.compatible && !['failed', 'blocked'].includes(item.state) && item.manifest.permissions.windowEffects)
    .flatMap(item => item.manifest.contributes.views.filter(view => view.location === 'window-overlay').map(view => inputs.value.find(input => input.extensionId === item.manifest.id && input.viewType === view.id)
      ?? { viewId: crypto.randomUUID(), extensionId: item.manifest.id, viewType: view.id, state: null, stateVersion: view.stateVersion, resource: null }))
}, { immediate: true })
const decorations = new Map<string, ExtensionViewInput>()
watch(() => [state.installed.value, [...anchors.entries.values()]] as const, ([installed, entries]) => {
  const retained = new Set<string>()
  for (const plugin of installed.filter(item => item.enabled && item.compatible && !['failed', 'blocked'].includes(item.state))) {
    for (const placement of plugin.manifest.contributes.placements) {
      if (placement.kind !== 'decoration')
        continue
      const view = plugin.manifest.contributes.views.find(view => view.id === placement.view)!
      for (const anchor of entries.filter(anchor => anchor.kind === placement.anchor)) {
        const key = `${placement.id}:${anchor.id}`
        retained.add(key)
        let input = decorations.get(key)
        if (!input || input.viewType !== view.id) {
          if (input)
            views.hide(input.viewId)
          input = { viewId: crypto.randomUUID(), extensionId: plugin.manifest.id, viewType: view.id, placementId: placement.id, state: null, stateVersion: view.stateVersion, resource: null }
          decorations.set(key, input)
        }
        views.show(input, anchor.element, true, { anchor })
      }
    }
  }
  for (const [key, input] of decorations) {
    if (!retained.has(key)) {
      views.hide(input.viewId)
      decorations.delete(key)
    }
  }
}, { immediate: true, flush: 'post' })
onScopeDispose(() => {
  for (const input of decorations.values()) views.hide(input.viewId)
  decorations.clear()
})
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
