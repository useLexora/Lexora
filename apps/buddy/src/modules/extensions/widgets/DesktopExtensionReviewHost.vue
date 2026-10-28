<script setup lang="ts">
import type { ExtensionReview } from '@buddy-shared/extensions/extensionApi'
import type { ExtensionIncompatibleReview } from '@buddy-shared/extensions/extensionCompatibility'
import type { FileOpeningChoice } from '@buddy-shared/files/fileOpening'
import { useMessage } from 'naive-ui'
import { onScopeDispose, shallowRef } from 'vue'
import { useExtensionContext } from '../extensionContext'
import { extensionLabels } from '../extensionLabels'
import { extensionErrorCode } from '../state/useExtensionState'
import DesktopExtensionIncompatibleReview from './DesktopExtensionIncompatibleReview.vue'
import DesktopExtensionInstallReview from './DesktopExtensionInstallReview.vue'

const { state, language } = useExtensionContext()
const message = useMessage()
const review = shallowRef<ExtensionReview | null>(null)
const incompatibleReview = shallowRef<ExtensionIncompatibleReview | null>(null)
function cancel() {
  const current = review.value
  review.value = null
  if (current)
    void state.api.cancelInstall(current.token).catch(() => {})
}
onScopeDispose(state.api.onReview((next) => {
  cancel()
  incompatibleReview.value = 'incompatibility' in next ? next : null
  review.value = 'token' in next ? next : null
}))
onScopeDispose(cancel)
async function install(applyUpdate: boolean, choices: FileOpeningChoice[]) {
  if (!review.value || state.busyIds.has(review.value.manifest.id))
    return
  const current = review.value
  review.value = null
  try {
    const installed = await state.install(current, applyUpdate, choices)
    if (installed && current.currentVersion) {
      const labels = extensionLabels(language.value)
      message.success(applyUpdate ? labels.updateApplied : labels.updateDeferred)
    }
  }
  catch (error) { message.error(extensionErrorCode(error)) }
}
</script>

<template>
  <DesktopExtensionInstallReview v-if="review" :key="review.token" :review="review" :language="language" :busy="state.busyIds.has(review.manifest.id)" @cancel="cancel" @install="install" />
  <DesktopExtensionIncompatibleReview v-if="incompatibleReview" :review="incompatibleReview" :language="language" @close="incompatibleReview = null" />
</template>
