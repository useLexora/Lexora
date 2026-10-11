<script setup lang="ts">
defineProps<{ color?: string | null, compact?: boolean }>()
</script>

<template>
  <span class="desktop-task-mark-swatch inline-block w-[8px] h-[8px] flex-none rounded-[2px] box-border" :class="{ 'is-empty': !color, 'is-compact': compact }" :style="{ backgroundColor: color ?? undefined }" aria-hidden="true" />
</template>

<style scoped lang="scss">
.desktop-task-mark-swatch {
  border: 1px solid color-mix(in srgb, var(--buddy-text-primary) 18%, transparent);
}
.desktop-task-mark-swatch.is-empty { visibility: hidden; }
.desktop-task-mark-swatch.is-compact {
  width: 3px;
  height: 10px;
  border: 0;
  border-radius: 1px;
}
</style>
