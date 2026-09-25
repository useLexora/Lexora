<script setup lang="ts">
defineSlots<{ default: () => unknown, toolbar?: () => unknown }>()
</script>

<template>
  <div class="workbench-panel-content">
    <div v-if="$slots.toolbar" class="workbench-panel-content__toolbar">
      <slot name="toolbar" />
    </div>
    <div class="workbench-panel-content__body">
      <slot />
    </div>
  </div>
</template>

<style scoped>
.workbench-panel-content { display: flex; flex: 1; min-width: 0; min-height: 0; flex-direction: column; }
.workbench-panel-content__toolbar { display: flex; min-width: 0; flex: none; min-height: var(--buddy-context-toolbar-height); align-items: center; border-bottom: 1px solid var(--buddy-border-subtle); }
.workbench-panel-content__body { display: flex; flex: 1; min-width: 0; min-height: 0; overflow: hidden; }
</style>
