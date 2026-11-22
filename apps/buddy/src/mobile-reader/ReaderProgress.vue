<script setup lang="ts">
defineProps<{ label: string }>()
</script>

<template>
  <span class="progress-ring" role="status" :aria-label="label" />
</template>

<style scoped>
.progress-ring {
  display: inline-block;
  box-sizing: border-box;
  width: 18px;
  height: 18px;
  vertical-align: middle;
  border: 2px solid var(--reader-border);
  border-top-color: currentColor;
  border-radius: 50%;
  animation: reader-spin .8s linear infinite;
}
@keyframes reader-spin { to { transform: rotate(1turn); } }
@media (prefers-reduced-motion: reduce) { .progress-ring { animation: none; } }
</style>
