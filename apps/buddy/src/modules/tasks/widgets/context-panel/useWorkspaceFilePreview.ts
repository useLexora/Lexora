import type { LocalChatApi } from '@buddy-electron/shared/localChatApi'
import type { TreeOption } from 'naive-ui'
import type { Ref } from 'vue'
import type { TaskFilesContextTab } from '@/modules/tasks/model/context-panel/taskContextPanel'
import { computed, onScopeDispose, shallowReactive, watch, watchEffect } from 'vue'

export type WorkspaceFilesApi = Pick<LocalChatApi['spaces'], 'listDirectory' | 'readFile' | 'revealFile'>
interface FileView {
  nodes: TreeOption[]
  expandedKeys: Array<string | number>
  treeVisible: boolean
  treeWidth: number
  wrap: boolean
  treeFailed: boolean
}

export function useWorkspaceFilePreview(tab: Readonly<Ref<TaskFilesContextTab | null>>, api: WorkspaceFilesApi, hasTab: (id: string) => boolean) {
  const views = shallowReactive(new Map<string, FileView>())
  let disposed = false
  watchEffect(() => {
    for (const id of views.keys()) {
      if (!hasTab(id))
        views.delete(id)
    }
  })
  onScopeDispose(() => {
    disposed = true
    views.clear()
  })
  const current = computed(() => tab.value ? views.get(tab.value.id) ?? null : null)
  watch(tab, (value) => {
    if (!value)
      return
    let view = views.get(value.id)
    if (!view) {
      view = shallowReactive<FileView>({ nodes: [], expandedKeys: [], treeVisible: true, treeWidth: 220, wrap: false, treeFailed: false })
      views.set(value.id, view)
      const newView = view
      void readNodes(value, '', newView).then((nodes) => {
        if (retained(value.id, newView))
          newView.nodes = nodes
      }).catch(() => {
        if (retained(value.id, newView))
          newView.treeFailed = true
      })
    }
  }, { immediate: true, flush: 'sync' })

  function retained(id: string, view: FileView): boolean {
    return !disposed && hasTab(id) && views.get(id) === view
  }

  async function readNodes(value: TaskFilesContextTab, path: string, view: FileView): Promise<TreeOption[]> {
    const nodes: TreeOption[] = []
    let cursor: string | undefined
    do {
      const page = await api.listDirectory({ ...value.target, path, cursor })
      if (!retained(value.id, view))
        return []
      nodes.push(...page.entries.map(entry => ({
        key: entry.path,
        label: entry.name,
        kind: entry.kind,
        isLeaf: entry.kind === 'file',
        disabled: entry.unavailable,
      })))
      cursor = page.nextCursor ?? undefined
    } while (cursor)
    return nodes
  }

  async function load(node: TreeOption): Promise<void> {
    const value = tab.value
    const view = current.value
    if (!value || !view)
      return
    try {
      const children = await readNodes(value, String(node.key), view)
      if (retained(value.id, view)) {
        view.nodes = replaceChildren(view.nodes, node.key!, children)
        view.treeFailed = false
      }
    }
    catch {
      if (retained(value.id, view))
        view.treeFailed = true
    }
  }

  return { current, load }
}

function replaceChildren(nodes: TreeOption[], key: string | number, children: TreeOption[]): TreeOption[] {
  return nodes.map(node => node.key === key ? { ...node, children } : node.children ? { ...node, children: replaceChildren(node.children, key, children) } : node)
}
