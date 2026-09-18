<script setup lang="ts">
import type { ExtensionReview } from '@buddy-shared/extensions/extensionApi'
import { useMessage } from 'naive-ui'
import { onScopeDispose, shallowRef } from 'vue'
import { useExtensionContext } from '../extensionContext'
import { extensionErrorCode } from '../state/useExtensionState'
import DesktopExtensionInstallReview from './DesktopExtensionInstallReview.vue'

const { state, language } = useExtensionContext()
const message = useMessage()
const review = shallowRef<ExtensionReview | null>(null)
const busy = shallowRef(false)
function cancel() {
  const current = review.value
  review.value = null
  if (current)
    void state.api.cancelInstall(current.token).catch(() => {})
}
onScopeDispose(state.api.onReview((next) => {
  cancel()
  review.value = next
}))
onScopeDispose(cancel)
async function install() {
  if (!review.value || busy.value)
    return
  busy.value = true
  const current = review.value
  try {
    await state.api.install(current.token)
    if (review.value === current)
      review.value = null
    await state.refresh()
  }
  catch (error) { message.error(extensionErrorCode(error)) }
  finally { busy.value = false }
}
</script>

<template>
  <DesktopExtensionInstallReview v-if="review" :review="review" :language="language" :busy="busy" @cancel="cancel" @install="install" />
</template>
