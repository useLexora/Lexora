<script setup lang="ts">
import type { VirtualListInst } from 'naive-ui'
import type { ExplorerNode, ExplorerRow as TreeRow } from './treeCollection'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { NVirtualList } from 'naive-ui'
import { nextTick, useId, useTemplateRef } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import ExplorerRow from './ExplorerRow.vue'
import { useTreeNavigation } from './useTreeNavigation'

const props = defineProps<{
  language: BuddyLocale
  nodes: readonly ExplorerNode[]
  selectedKey: string | null
  loadingKeys?: ReadonlySet<string>
  load?: (node: ExplorerNode) => Promise<void>
}>()
const emit = defineEmits<{ select: [key: string], contextmenu: [node: ExplorerNode | null, event: MouseEvent], command: [command: string, node: ExplorerNode | null] }>()
const expandedKeys = defineModel<string[]>('expandedKeys', { required: true })
const list = useTemplateRef<VirtualListInst>('list')
const tree = useTemplateRef<HTMLElement>('tree')
const id = useId()
const { t } = useBuddyI18n(() => props.language)
const navigation = useTreeNavigation({
  nodes: () => props.nodes,
  expanded: expandedKeys,
  selected: () => props.selectedKey,
  load: node => props.load?.(node) ?? Promise.resolve(),
  open: key => emit('select', key),
  scroll: (key) => { void nextTick(() => list.value?.scrollTo({ key })) },
})
const { rows, expanded, focused, pending } = navigation
function statusLabel(node: ExplorerNode) {
  return node.changeType ? t(`desktop.context.changeType.${node.changeType}`) : undefined
}
const rowId = (key: string) => `${id}-${encodeURIComponent(key)}`
function activate(row: TreeRow) {
  tree.value?.focus({ preventScroll: true })
  navigation.activate(row)
}
function toggle(row: TreeRow) {
  navigation.focus(row.key)
  tree.value?.focus({ preventScroll: true })
  void navigation.toggle(row.node)
}
function contextmenu(row: TreeRow, event: MouseEvent) {
  navigation.focus(row.key)
  tree.value?.focus({ preventScroll: true })
  emit('contextmenu', row.node, event)
}
function keydown(event: KeyboardEvent) {
  const node = rows.value.find(row => row.key === focused.value)?.node ?? null
  const modifier = event.ctrlKey || event.metaKey
  const command = event.key === 'F2' ? 'rename' : event.key === 'Delete' ? 'trash' : modifier && ['c', 'x', 'v'].includes(event.key.toLowerCase()) ? ({ c: 'copy', x: 'cut', v: 'paste' }[event.key.toLowerCase()]) : undefined
  if (command) {
    event.preventDefault()
    emit('command', command, node)
    return
  }
  if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
    event.preventDefault()
    const rect = tree.value?.getBoundingClientRect()
    emit('contextmenu', node, new MouseEvent('contextmenu', { clientX: (rect?.left ?? 0) + 24, clientY: (rect?.top ?? 0) + 24 }))
    return
  }
  navigation.keydown(event)
}
</script>

<template>
  <div ref="tree" role="tree" tabindex="0" :aria-label="t('desktop.context.files')" :aria-activedescendant="focused ? rowId(focused) : undefined" class="explorer-tree min-h-0 flex-1" data-testid="context-file-tree" @keydown="keydown" @contextmenu.prevent="emit('contextmenu', null, $event)">
    <NVirtualList ref="list" :items="rows" :item-size="24" :padding-top="4" :padding-bottom="4" class="explorer-list">
      <template #default="{ item }">
        <ExplorerRow :id="rowId(item.key)" :key="item.key" :row="item" :expanded="expanded.has(item.key)" :focused="focused === item.key" :selected="selectedKey === item.key" :loading="pending.has(item.key) || !!loadingKeys?.has(item.key)" :status-label="statusLabel(item.node)" @activate="activate(item)" @toggle="toggle(item)" @contextmenu="contextmenu(item, $event)" />
      </template>
    </NVirtualList>
  </div>
</template>

<style scoped lang="scss">
.explorer-tree { outline: none; overflow: hidden; }
.explorer-list { height: 100%; }
.explorer-tree:focus-within :deep(.explorer-row.is-focused) { outline: 1px solid var(--buddy-accent-solid); outline-offset: -1px; }
.explorer-tree:focus-within :deep(.explorer-row.is-selected) { background: color-mix(in srgb, var(--buddy-accent-solid) 18%, transparent); }
</style>
