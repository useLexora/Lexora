<script setup lang="ts">
import type { ExtensionTaskCleanupConfirmation } from '@buddy-shared/extensions/extensionTaskCleanup'
import { computed, onScopeDispose, shallowRef, watch } from 'vue'
import { useExtensionContext } from '../extensionContext'
import { extensionTaskCleanupLabels } from '../state/extensionTaskCleanupLabels'
import { extensionErrorCode } from '../state/useExtensionState'
import DesktopExtensionTaskCleanupDialog from './DesktopExtensionTaskCleanupDialog.vue'

const { state, language } = useExtensionContext()
const confirmations = shallowRef<ExtensionTaskCleanupConfirmation[]>([])
const selected = computed(() => confirmations.value[0])
const labels = computed(() => extensionTaskCleanupLabels(language.value))
const name = computed(() => state.installed.value.find(item => item.manifest.id === selected.value?.extensionId)?.manifest.name ?? labels.value.plugin)
const busy = shallowRef(false)
const error = shallowRef<string | null>(null)
let disposed = false
let dirty = false
let refreshing: Promise<void> | undefined
function refresh(): Promise<void> {
  dirty = true
  if (!refreshing) {
    refreshing = (async () => {
      while (dirty) {
        if (disposed)
          break
        dirty = false
        try {
          const result = await state.api.taskCleanupConfirmations()
          if (!disposed)
            confirmations.value = result
        }
        catch {
          if (!disposed)
            error.value = labels.value.responseFailed
        }
      }
    })().finally(() => { refreshing = undefined })
  }
  return refreshing
}
watch(() => selected.value?.id, () => {
  error.value = null
  busy.value = false
})
async function confirm(confirmed: boolean) {
  const request = selected.value
  if (!request || busy.value)
    return
  busy.value = true
  error.value = null
  try {
    await state.api.confirmTaskCleanup(request.extensionId, request.id, confirmed)
  }
  catch (reason) {
    if (!disposed && selected.value?.id === request.id)
      error.value = extensionErrorCode(reason) === 'EXTENSION_TASK_CLEANUP_EXPIRED' ? labels.value.expired : labels.value.responseFailed
  }
  finally {
    await refresh()
    if (!disposed && selected.value?.id === request.id)
      busy.value = false
  }
}
onScopeDispose(state.api.onChanged(() => void refresh()))
onScopeDispose(() => {
  disposed = true
})
void refresh()
</script>

<template>
  <DesktopExtensionTaskCleanupDialog v-if="selected" :key="selected.id" :confirmation="selected" :name="name" :language="language" :busy="busy" :error="error" @confirm="confirm" />
</template>
