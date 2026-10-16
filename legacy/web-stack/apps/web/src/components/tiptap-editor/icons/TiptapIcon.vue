<script setup lang="ts">
import { useAttrs } from 'vue'

defineOptions({
  inheritAttrs: false,
})

defineProps<{
  /** 图标名 */
  icon: string
}>()

const attrs = useAttrs()
</script>

<template>
  <SvgIcon
    v-bind="attrs"
    category="tiptap"
    :icon="icon"
  />
</template>
