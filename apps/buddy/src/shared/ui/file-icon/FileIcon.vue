<script setup lang="ts">
import { computed } from 'vue'
import { getFileIconUrl } from './fileIcon'
import { resolveFileIcon } from './resolveFileIcon'

const props = withDefaults(defineProps<{
  name: string
  size?: 'medium' | 'preview' | 'small'
}>(), {
  size: 'small',
})

const iconName = computed(() => resolveFileIcon(props.name))
const iconUrl = computed(() => getFileIconUrl(iconName.value))
</script>

<template>
  <img
    alt=""
    class="buddy-file-icon block flex-none"
    :class="`is-${size}`"
    :data-file-icon="iconName"
    draggable="false"
    :src="iconUrl"
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
