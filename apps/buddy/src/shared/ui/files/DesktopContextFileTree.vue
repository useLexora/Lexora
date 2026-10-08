<script setup lang="ts">
import type { TreeOption, TreeOverrideNodeClickBehavior } from 'naive-ui'
import type { FileTreeMenuTarget } from './fileTreeContextMenu'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { NTree } from 'naive-ui'
import { computed, h } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import { FileIcon, FolderIcon } from '@/shared/ui/file-icon'

const props = defineProps<{
  language: BuddyLocale
  nodes: readonly TreeOption[]
  selectedKey: string | null
  load?: (node: TreeOption) => Promise<void>
  contextMenu?: boolean
}>()
const emit = defineEmits<{ select: [key: string], menu: [target: FileTreeMenuTarget] }>()
const expandedKeys = defineModel<Array<string | number>>('expandedKeys', { required: true })
const { t } = useBuddyI18n(() => props.language)
const data = computed(() => [...props.nodes])
const expanded = computed(() => new Set(expandedKeys.value))
const clickBehavior: TreeOverrideNodeClickBehavior = ({ option }) => option.kind === 'directory' ? 'toggleExpand' : 'toggleSelect'
function prefix({ option }: { option: TreeOption }) {
  return option.kind === 'directory'
    ? h(FolderIcon, { expanded: expanded.value.has(option.key!), class: 'context-tree-icon' })
    : h(FileIcon, { name: String(option.label), class: 'context-tree-icon' })
}
function suffix({ option }: { option: TreeOption }) {
  const node = option as TreeOption & { changeType?: 'created' | 'modified' | 'deleted' }
  if (!node.changeType)
    return null
  const mark = node.changeType === 'created'
    ? h('path', { d: 'M5 8h6M8 5v6' })
    : node.changeType === 'deleted'
      ? h('path', { d: 'M5 8h6' })
      : h('circle', { cx: 8, cy: 8, fill: 'currentColor', r: 1.5, stroke: 'none' })
  return h('svg', {
    'class': ['context-tree-status', `is-${node.changeType}`],
    'aria-label': t(`desktop.context.changeType.${node.changeType}`),
    'role': 'img',
    'viewBox': '0 0 16 16',
    'fill': 'none',
    'stroke': 'currentColor',
    'stroke-width': 1.5,
    'stroke-linecap': 'round',
  }, [h('rect', { height: 11.5, rx: 2, width: 11.5, x: 2.25, y: 2.25 }), mark])
}
function menu(event: MouseEvent | KeyboardEvent, option?: TreeOption) {
  if (!props.contextMenu)
    return
  if (event instanceof KeyboardEvent && !(event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')))
    return
  event.preventDefault()
  event.stopPropagation()
  emit('menu', { event, path: option ? String(option.key) : '', name: option ? String(option.label) : '', kind: option?.kind === 'file' ? 'file' : 'directory', writable: !option?.disabled && option?.writable !== false, unavailable: Boolean(option?.disabled) })
}
function nodeProps({ option }: { option: TreeOption }) {
  if (!props.contextMenu)
    return {}
  return { tabindex: 0, onContextmenu: (event: MouseEvent) => menu(event, option), onKeydown: (event: KeyboardEvent) => menu(event, option) }
}
function rootKey(event: KeyboardEvent) {
  if (event.target === event.currentTarget)
    menu(event)
}
function select(keys: Array<string | number>) {
  const key = keys.at(-1)
  if (typeof key === 'string')
    emit('select', key)
}
</script>

<template>
  <div class="desktop-context-file-tree" data-testid="context-file-tree" :tabindex="contextMenu ? 0 : undefined" @contextmenu="menu($event)" @keydown="rootKey">
    <NTree
      v-model:expanded-keys="expandedKeys" block-line :cancelable="false" :data="data" :on-load="load"
      :node-props="nodeProps" :override-default-node-click-behavior="clickBehavior" :render-prefix="prefix" :render-suffix="suffix"
      :selected-keys="selectedKey ? [selectedKey] : []" @update:selected-keys="select"
    />
  </div>
</template>

<style scoped>
.desktop-context-file-tree { min-height: 0; flex: 1; overflow: auto; padding: 8px 6px; }
.desktop-context-file-tree :deep(.n-tree-node) { min-height: 30px; border-radius: var(--buddy-icon-button-radius); }
.desktop-context-file-tree :deep(.n-tree-node-content) { min-width: 0; }
.desktop-context-file-tree :deep(.n-tree-node-content__text) { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
.desktop-context-file-tree :deep(.context-tree-icon) { width: 16px; height: 16px; }
.desktop-context-file-tree :deep(.context-tree-status) { display: grid; place-items: center; width: 14px; height: 14px; flex: none; margin: 0 4px; }
.desktop-context-file-tree :deep(.is-created) { color: var(--buddy-status-success-text); }
.desktop-context-file-tree :deep(.is-deleted) { color: var(--buddy-status-danger-text); }
.desktop-context-file-tree :deep(.is-modified) { color: var(--buddy-status-warning-text); }
</style>
