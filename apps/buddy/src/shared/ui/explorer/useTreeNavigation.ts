import type { Ref } from 'vue'
import type { ExplorerNode, ExplorerRow } from './treeCollection'
import { computed, onScopeDispose, shallowReactive, shallowRef, watch } from 'vue'
import { flattenTree } from './treeCollection'

export function useTreeNavigation(options: {
  nodes: () => readonly ExplorerNode[]
  expanded: Ref<string[]>
  selected: () => string | null
  load: (node: ExplorerNode) => Promise<void>
  open: (key: string) => void
  scroll: (key: string) => void
}) {
  const focused = shallowRef<string | null>(options.selected())
  const pending = shallowReactive(new Set<string>())
  const expanded = computed(() => new Set(options.expanded.value))
  const rows = computed(() => flattenTree(options.nodes(), expanded.value))
  let stopped = false
  let typed = ''
  let typedAt = 0
  onScopeDispose(() => stopped = true)
  watch(rows, (items) => {
    if (!items.some(row => row.key === focused.value))
      focused.value = items.find(row => row.key === options.selected())?.key ?? items[0]?.key ?? null
  }, { immediate: true })
  watch(options.selected, (key) => {
    if (key && rows.value.some(row => row.key === key))
      focus(key)
  })

  function focus(key: string) {
    focused.value = key
    options.scroll(key)
  }

  async function toggle(node: ExplorerNode, open = !expanded.value.has(node.key)) {
    if (node.kind !== 'directory' || node.disabled)
      return
    if (!open) {
      options.expanded.value = options.expanded.value.filter(key => key !== node.key)
      return
    }
    if (!expanded.value.has(node.key))
      options.expanded.value = [...options.expanded.value, node.key]
    if (!node.children && !pending.has(node.key)) {
      pending.add(node.key)
      try {
        await options.load(node)
      }
      finally {
        if (!stopped)
          pending.delete(node.key)
      }
    }
  }

  function activate(row: ExplorerRow) {
    focus(row.key)
    if (row.node.disabled)
      return
    if (row.node.kind === 'directory')
      void toggle(row.node)
    else options.open(row.key)
  }

  function keydown(event: KeyboardEvent) {
    if (event.altKey || event.metaKey || event.ctrlKey)
      return
    const index = rows.value.findIndex(row => row.key === focused.value)
    const row = rows.value[index]
    let next: ExplorerRow | undefined
    switch (event.key) {
      case 'ArrowDown': next = rows.value[Math.min(index + 1, rows.value.length - 1)]
        break
      case 'ArrowUp': next = rows.value[Math.max(index - 1, 0)]
        break
      case 'Home': next = rows.value[0]
        break
      case 'End': next = rows.value.at(-1)
        break
      case 'PageDown': next = rows.value[Math.min(index + 10, rows.value.length - 1)]
        break
      case 'PageUp': next = rows.value[Math.max(index - 10, 0)]
        break
      case 'ArrowRight':
        if (row?.node.kind === 'directory') {
          if (!expanded.value.has(row.key))
            void toggle(row.node, true)
          else next = rows.value[index + 1]?.parent === row.key ? rows.value[index + 1] : undefined
        }
        break
      case 'ArrowLeft':
        if (row && expanded.value.has(row.key))
          void toggle(row.node, false)
        else next = rows.value.find(item => item.key === row?.parent)
        break
      case 'Enter': case ' ': if (row)
        activate(row)
        break
      case '*':
        for (const sibling of rows.value.filter(item => item.parent === row?.parent && item.node.kind === 'directory')) void toggle(sibling.node, true)
        break
      default: {
        if (event.key.length !== 1 || event.isComposing)
          return
        typed = Date.now() - typedAt > 700 ? event.key : typed + event.key
        typedAt = Date.now()
        const search = [...rows.value.slice(index + 1), ...rows.value.slice(0, index + 1)]
        next = search.find(item => item.node.label.toLocaleLowerCase().startsWith(typed.toLocaleLowerCase()))
      }
    }
    event.preventDefault()
    if (next)
      focus(next.key)
  }

  return { rows, expanded, focused, pending, focus, toggle, activate, keydown }
}
