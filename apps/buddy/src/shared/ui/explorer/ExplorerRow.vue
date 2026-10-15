<script setup lang="ts">
import type { ExplorerRow } from './treeCollection'
import { FileIcon, FolderIcon } from '@/shared/ui/file-icon'
import { desktopFileIconSnapshot } from '@/theme/desktopFileIconState'

const props = defineProps<{
  row: ExplorerRow
  expanded: boolean
  selected: boolean
  focused: boolean
  loading: boolean
  statusLabel?: string
}>()
const emit = defineEmits<{ activate: [], toggle: [], contextmenu: [event: MouseEvent] }>()
</script>

<template>
  <div
    role="treeitem" :aria-level="row.level" :aria-posinset="row.position" :aria-setsize="row.siblings"
    :aria-expanded="row.node.kind === 'directory' ? expanded : undefined" :aria-selected="selected"
    :aria-disabled="row.node.disabled || undefined" :aria-busy="loading || undefined"
    class="explorer-row" :class="{ 'is-selected': selected, 'is-focused': focused, 'is-disabled': row.node.disabled }"
    :style="{ paddingInlineStart: `${4 + (row.level - 1) * 12}px` }"
    :data-path="row.key" @click="emit('activate')" @contextmenu.prevent.stop="emit('contextmenu', $event)"
  >
    <span v-for="level in row.level - 1" :key="level" aria-hidden="true" class="explorer-guide" :style="{ insetInlineStart: `${11 + (level - 1) * 12}px` }" />
    <span v-if="!desktopFileIconSnapshot.active?.document.hidesExplorerArrows" class="explorer-disclosure" aria-hidden="true" @click.stop="emit('toggle')">
      <svg v-if="row.node.kind === 'directory'" viewBox="0 0 16 16" :class="{ 'is-expanded': expanded, 'is-loading': loading }">
        <path v-if="!loading" d="m6 4 4 4-4 4" />
        <path v-else d="M13 8a5 5 0 1 1-5-5" />
      </svg>
    </span>
    <FolderIcon v-if="row.node.kind === 'directory'" :name="row.key" :expanded="expanded" class="explorer-folder" />
    <FileIcon v-else :name="row.key" class="explorer-file-icon" />
    <span class="explorer-label">{{ row.node.label }}</span>
    <span v-if="row.node.changeType" class="explorer-status" :class="`is-${row.node.changeType}`" :aria-label="statusLabel">{{ props.row.node.changeType === 'created' ? '+' : props.row.node.changeType === 'deleted' ? '−' : '●' }}</span>
  </div>
</template>

<style scoped lang="scss">
.explorer-row {
  position: relative;
  display: flex;
  align-items: center;
  gap: 4px;
  height: 24px;
  box-sizing: border-box;
  padding-inline-end: 8px;
  cursor: default;
  user-select: none;
  font-size: 12px;
  line-height: 18px;
  color: var(--buddy-text-primary);
}
.explorer-row:hover {
  background: var(--buddy-state-hover);
}
.explorer-row.is-selected {
  background: color-mix(in srgb, var(--buddy-accent-solid) 12%, transparent);
}
.explorer-row.is-disabled {
  opacity: 0.45;
}
.explorer-guide {
  position: absolute;
  height: 100%;
  top: 0;
  border-inline-start: 1px solid var(--buddy-border-subtle);
  opacity: 0.5;
  pointer-events: none;
}
.explorer-disclosure {
  display: grid;
  place-items: center;
  width: 16px;
  height: 24px;
  flex: none;
  color: var(--buddy-text-secondary);
}
.explorer-disclosure svg {
  width: 12px;
  height: 12px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.4;
  stroke-linecap: round;
  stroke-linejoin: round;
  transition: transform 120ms ease;
}
.explorer-disclosure .is-expanded {
  transform: rotate(90deg);
}
.explorer-disclosure .is-loading {
  animation: explorer-spin 1s linear infinite;
}
.explorer-folder, .explorer-file-icon {
  width: 16px;
  height: 16px;
  flex: none;
}
.explorer-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  min-width: 0;
}
.explorer-status {
  width: 14px;
  flex: none;
  text-align: center;
  font-size: 11px;
}
.is-created {
  color: var(--buddy-status-success-text);
}
.is-deleted {
  color: var(--buddy-status-danger-text);
}
.is-modified {
  color: var(--buddy-status-warning-text);
}
@keyframes explorer-spin {
  to {
    transform: rotate(360deg);
  }
}
@media (prefers-reduced-motion: reduce) {
  .explorer-disclosure svg {
    transition: none;
  }
}
</style>
