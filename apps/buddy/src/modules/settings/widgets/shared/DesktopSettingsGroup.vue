<script setup lang="ts">
defineProps<{ unframed?: boolean, fill?: boolean }>()
</script>

<template>
  <div
    class="desktop-settings-group"
    :class="unframed
      ? ['gap-[1.8rem] overflow-visible border-0 rounded-0 bg-transparent', fill ? 'flex flex-1 min-w-0 min-h-0' : 'grid']
      : 'overflow-hidden border border-solid border-border rounded-[0.65rem] bg-surface'"
  >
    <slot />
  </div>
</template>
