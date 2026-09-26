<script setup lang="ts">
import type { WorkbenchInteraction } from '@buddy-shared/workbench/workbenchInteraction'

defineProps<{ entries: readonly WorkbenchInteraction[], language: string }>()
const emit = defineEmits<{ end: [id: string] }>()
</script>

<template>
  <Teleport to="body">
    <div v-if="entries.length" class="workbench-interactions" data-testid="workbench-interactions">
      <button v-for="entry in entries" :key="entry.id" type="button" @click="emit('end', entry.id)">
        <span>{{ language === 'zh-CN' ? '结束' : 'End' }} {{ entry.title }}</span><kbd>Esc</kbd>
      </button>
    </div>
  </Teleport>
</template>

<style scoped>
.workbench-interactions { position: fixed; top: 48px; right: 16px; z-index: 2147483647; display: flex; flex-wrap: wrap; gap: 8px; max-width: calc(100vw - 32px); }
.workbench-interactions button { display: flex; gap: 12px; align-items: center; border: 1px solid var(--buddy-border-subtle); border-radius: 6px; padding: 8px 12px; background: var(--buddy-surface-raised); color: var(--buddy-text-primary); font: inherit; cursor: pointer; }
.workbench-interactions button:focus-visible { outline: 2px solid var(--buddy-accent-solid); }
.workbench-interactions kbd { font-size: 11px; color: var(--buddy-text-secondary); }
</style>
