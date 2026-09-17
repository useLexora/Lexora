import type { LocalChatApi } from '@buddy-electron/shared/localChatApi'
import type { LocalSpaceFilePreview } from '@buddy-shared/spaces/spaceFileApi'
import type { TreeOption } from 'naive-ui'
import type { Ref } from 'vue'
import type { TaskFilesContextTab } from '@/modules/tasks/model/context-panel/taskContextPanel'
import { computed, shallowReactive, watch } from 'vue'

export type WorkspaceFilesApi = Pick<LocalChatApi['spaces'], 'listDirectory' | 'readFile' | 'revealFile'>
interface FileView {
  nodes: TreeOption[]
  expandedKeys: Array<string | number>
  treeVisible: boolean
  treeWidth: number
  wrap: boolean
  loading: boolean
  failed: boolean
  treeFailed: boolean
  preview: LocalSpaceFilePreview | null
}

export function useWorkspaceFilePreview(tab: Readonly<Ref<TaskFilesContextTab | null>>, api: WorkspaceFilesApi) {
  const views = shallowReactive(new Map<string, FileView>())
  const current = computed(() => tab.value ? views.get(tab.value.id) ?? null : null)
  watch(tab, async (value, previous, onCleanup) => {
    if (!value)
      return
    let active = true
    onCleanup(() => {
      active = false
    })
    let view = views.get(value.id)
    if (!view) {
      view = shallowReactive<FileView>({ nodes: [], expandedKeys: [], treeVisible: true, treeWidth: 220, wrap: false, loading: false, failed: false, treeFailed: false, preview: null })
      views.set(value.id, view)
      const newView = view
      void readNodes(value, '').then((nodes) => {
        newView.nodes = nodes
      }).catch(() => {
        newView.treeFailed = true
      })
    }
    if (value.target === previous?.target && value.id === previous.id)
      return
    view.failed = false
    view.preview = null
    view.loading = Boolean(value.target.path)
    if (!value.target.path)
      return
    try {
      const preview = await api.readFile({ ...value.target })
      if (active)
        view.preview = preview
    }
    catch {
      if (active)
        view.failed = true
    }
    finally {
      if (active)
        view.loading = false
    }
  }, { immediate: true, flush: 'sync' })

  async function readNodes(value: TaskFilesContextTab, path: string): Promise<TreeOption[]> {
    const nodes: TreeOption[] = []
    let cursor: string | undefined
    do {
      const page = await api.listDirectory({ ...value.target, path, cursor })
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
      const children = await readNodes(value, String(node.key))
      view.nodes = replaceChildren(view.nodes, node.key!, children)
      view.treeFailed = false
    }
    catch {
      view.treeFailed = true
    }
  }

  return { current, load }
}

function replaceChildren(nodes: TreeOption[], key: string | number, children: TreeOption[]): TreeOption[] {
  return nodes.map(node => node.key === key ? { ...node, children } : node.children ? { ...node, children: replaceChildren(node.children, key, children) } : node)
}
