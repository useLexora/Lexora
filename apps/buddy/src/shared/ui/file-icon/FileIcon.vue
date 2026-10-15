<script setup lang="ts">
import { computed } from 'vue'
import { applyIconFallback, resolveResourceIcon } from './fileIcon'

const props = withDefaults(defineProps<{
  name: string
  size?: 'medium' | 'preview' | 'small'
}>(), {
  size: 'small',
})

const icon = computed(() => resolveResourceIcon({ path: props.name, kind: 'file' }))
</script>

<template>
  <img
    alt=""
    class="buddy-file-icon block flex-none"
    :class="`is-${size}`"
    :data-file-icon="icon.id"
    draggable="false"
    :src="icon.url"
    @error="applyIconFallback($event, icon.fallbackUrl)"
  >
</template>

<style scoped lang="scss">
.buddy-file-icon {
  object-fit: contain;
}

.buddy-file-icon.is-small {
  width: 1rem;
  height: 1rem;
}

.buddy-file-icon.is-preview {
  width: 3.25rem;
  height: 3.25rem;
}

.buddy-file-icon.is-medium {
  width: 1.4rem;
  height: 1.4rem;
}
</style>
