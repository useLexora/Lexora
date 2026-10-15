<script setup lang="ts">
import { computed } from 'vue'
import { applyIconFallback, resolveResourceIcon } from './fileIcon'

const props = defineProps<{
  name?: string
  expanded?: boolean
}>()
const icon = computed(() => resolveResourceIcon({ path: props.name ?? '', kind: 'directory', expanded: props.expanded }))
</script>

<template>
  <img
    alt=""
    class="buddy-folder-icon block flex-none"
    :data-folder-icon="icon.id"
    draggable="false"
    :src="icon.url"
    @error="applyIconFallback($event, icon.fallbackUrl)"
  >
</template>

<style scoped lang="scss">
.buddy-folder-icon {
  object-fit: contain;
}
</style>
