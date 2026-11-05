<script setup lang="ts">
import type { ExtensionViewInput } from '@buddy-shared/extensions/extensionApi'
import type { ExtensionSettingsHeaderAction } from '@buddy-shared/extensions/extensionSettingsHeaderActions'
import { computed, onScopeDispose, watch } from 'vue'
import { onBeforeRouteLeave, onBeforeRouteUpdate } from 'vue-router'
import { useExtensionContext } from '../extensionContext'
import DesktopExtensionSurface from './DesktopExtensionSurface.vue'

const props = defineProps<{ extensionId: string, viewType: string, settingsHeaderActions?: boolean }>()
const emit = defineEmits<{ settingsHeaderActions: [actions: readonly ExtensionSettingsHeaderAction[]] }>()
const { views } = useExtensionContext()
const viewId = crypto.randomUUID()
const input = computed<ExtensionViewInput>(() => ({ viewId, extensionId: props.extensionId, viewType: props.viewType, resource: null, state: {}, stateVersion: 0 }))
const surface = computed(() => views.surfaces.get(viewId))
const actions = computed(() => {
  const current = surface.value
  return props.settingsHeaderActions && current?.ready && current.visible && current.eligible && !current.error ? current.settingsHeaderActions ?? [] : []
})
watch(actions, value => emit('settingsHeaderActions', value), { immediate: true, flush: 'sync' })
onScopeDispose(() => emit('settingsHeaderActions', []))
defineExpose({
  activateSettingsHeaderAction(id: string) {
    const session = surface.value?.session
    return session ? views.activateSettingsHeaderAction(viewId, session.generation, session.token, id) : false
  },
})
onBeforeRouteLeave(() => views.prepareClose(viewId))
onBeforeRouteUpdate(() => views.prepareClose(viewId))
</script>

<template>
  <DesktopExtensionSurface :input="input" :settings-header-actions="settingsHeaderActions" visible />
</template>
