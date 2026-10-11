<script setup lang="ts">
import { onErrorCaptured, shallowRef } from 'vue'
import { useWorkbench } from './workbenchContext'

const emit = defineEmits<{ error: [] }>()
const { labels } = useWorkbench()
const failed = shallowRef(false)
const attempt = shallowRef(0)
onErrorCaptured(() => {
  failed.value = true
  emit('error')
  return false
})
</script>

<template>
  <div v-if="failed" class="workbench-view-error m-auto p-[24px] text-muted text-center" role="alert">
    <p>{{ labels.failed }}</p>
    <button type="button" @click="failed = false; attempt++">
      {{ labels.retry }}
    </button>
  </div>
  <slot v-else :key="attempt" />
</template>
