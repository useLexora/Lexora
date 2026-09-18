<script setup lang="ts">
import { PuzzlePiece20Regular } from '@vicons/fluent'
import { computed, shallowRef, watch } from 'vue'
import DesktopIcon from './DesktopIcon.vue'

const props = withDefaults(defineProps<{ src?: string, size?: number | string }>(), { size: '1em' })
const length = computed(() => typeof props.size === 'number' ? `${props.size}px` : props.size)
const failed = shallowRef(false)
watch(() => props.src, () => {
  failed.value = false
})
</script>

<template>
  <span class="desktop-plugin-icon" :style="{ width: length, height: length }" aria-hidden="true">
    <img v-if="src && !failed" :src="src" alt="" draggable="false" @error="failed = true">
    <DesktopIcon v-else :component="PuzzlePiece20Regular" :size="size" />
  </span>
</template>

<style scoped>
.desktop-plugin-icon { display: inline-flex; flex: none; align-items: center; justify-content: center; }
.desktop-plugin-icon img { display: block; width: 100%; height: 100%; object-fit: contain; }
</style>
