<script setup lang="ts">
defineSlots<{ default: () => unknown, toolbar?: () => unknown }>()
</script>

<template>
  <div class="workbench-panel-content flex flex-1 min-w-0 min-h-0 flex-col">
    <div v-if="$slots.toolbar" class="flex min-w-0 flex-none min-h-[var(--buddy-context-toolbar-height)] items-center border-b-1 border-b-solid border-b-border">
      <slot name="toolbar" />
    </div>
    <div class="flex flex-1 min-w-0 min-h-0 overflow-hidden">
      <slot />
    </div>
  </div>
</template>
