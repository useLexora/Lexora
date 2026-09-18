<script setup lang="ts">
import { onErrorCaptured, shallowRef } from 'vue'
import { useWorkbench } from './workbenchContext'

const { labels } = useWorkbench()
const failed = shallowRef(false)
const attempt = shallowRef(0)
onErrorCaptured(() => {
  failed.value = true
  return false
})
</script>

<template>
  <div v-if="failed" class="workbench-view-error" role="alert">
    <p>{{ labels.failed }}</p>
    <button type="button" @click="failed = false; attempt++">
      {{ labels.retry }}
    </button>
  </div>
  <slot v-else :key="attempt" />
</template>

<style scoped>
.workbench-view-error { margin: auto; padding: 24px; color: var(--buddy-text-secondary); text-align: center; }
</style>
