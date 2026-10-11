<script setup lang="ts">
import { getFolderIconUrl } from './fileIcon'

defineProps<{
  expanded?: boolean
}>()
</script>

<template>
  <img
    alt=""
    class="buddy-folder-icon flex-none"
    draggable="false"
    :src="getFolderIconUrl(expanded)"
  >
</template>

<style scoped lang="scss">
.buddy-folder-icon {
  object-fit: contain;
}
</style>
