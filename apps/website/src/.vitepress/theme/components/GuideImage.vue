<script setup lang="ts">
import { useData } from 'vitepress'
import { computed } from 'vue'
import LandingImagePreview from './landing/LandingImagePreview.vue'

defineProps<{ src: string, alt: string, caption: string, width: number, height: number }>()
const { lang } = useData()
const english = computed(() => lang.value.startsWith('en'))
</script>

<template>
  <figure class="guide-image">
    <LandingImagePreview :src="src" :alt="alt" :title="caption" :width="width" :height="height" :enlarge="english ? 'Enlarge image' : '放大查看'" :close="english ? 'Close preview' : '关闭预览'" :original="english ? 'View original' : '查看原图'" />
    <figcaption>{{ caption }}</figcaption>
  </figure>
</template>

<style scoped>
.guide-image { margin: 28px 0; }
.guide-image :deep(.preview-trigger) { border: 1px solid var(--site-line); border-radius: 8px; }
.guide-image :deep(.preview-trigger:focus-visible) { outline: 2px solid var(--site-blue); outline-offset: 4px; }
.guide-image :deep(.preview-dialog) { z-index: 100; }
.guide-image :deep(.dialog-toolbar a) { text-decoration: none; }
.guide-image figcaption { margin-top: 10px; font-size: 13px; line-height: 1.7; color: var(--site-muted); }
</style>
