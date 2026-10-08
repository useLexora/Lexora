import type { SpaceFileTarget } from '@buddy-shared/spaces/spaceFileApi'
import type { TreeOption } from 'naive-ui'
import type { Ref } from 'vue'
import type { WorkspaceFilesApi } from '../../model/context-panel/workspaceFilesApi'
import type { TaskFilesContextTab } from '@/modules/tasks/model/context-panel/taskContextPanel'
import { pathInFileScope } from '@buddy-shared/spaces/spaceFileNames'
import { computed, onScopeDispose, shallowReactive, watch, watchEffect } from 'vue'

export type { WorkspaceFilesApi } from '../../model/context-panel/workspaceFilesApi'
interface FileView {
  target: SpaceFileTarget
  selectedKey: string | null
  stale: boolean
  generation: number
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
  const unsubscribe = api.onEntriesChanged?.((change) => {
    for (const view of views.values()) {
      if (view.target.directoryId !== change.target.directoryId || view.target.revision !== change.target.revision || view.target.spaceId !== change.target.spaceId)
        continue
      view.stale = true
      view.generation++
      if (change.removedPath) {
        view.expandedKeys = view.expandedKeys.filter(key => !pathInFileScope(String(key), change.removedPath!))
        if (view.selectedKey && pathInFileScope(view.selectedKey, change.removedPath))
          view.selectedKey = null
      }
    }
  })
  if (unsubscribe)
    onScopeDispose(unsubscribe)
  watch(tab, (value) => {
    if (!value)
      return
    let view = views.get(value.id)
    if (!view) {
      view = shallowReactive<FileView>({ target: { ...value.target }, selectedKey: null, stale: false, generation: 0, nodes: [], expandedKeys: [], treeVisible: true, treeWidth: 220, wrap: false, treeFailed: false })
      views.set(value.id, view)
      const newView = view
      const generation = view.generation
      void readNodes(value, '', newView).then((nodes) => {
        if (retained(value.id, newView, generation))
          newView.nodes = nodes
      }).catch(() => {
        if (retained(value.id, newView, generation))
          newView.treeFailed = true
      })
    }
    else if (view.stale) {
      void refresh(value)
    }
  }, { immediate: true, flush: 'sync' })

  watch(() => tab.value?.target.path, async (newPath) => {
    if (!newPath || !tab.value)
      return
    const value = tab.value
    const view = current.value
    if (!view)
      return
    const generation = view.generation
    const segments = newPath.split('/').filter(Boolean)
    if (segments.length <= 1)
      return
    const ancestorKeys: string[] = []
    let currentPath = ''
    for (let i = 0; i < segments.length - 1; i++) {
      currentPath = currentPath ? `${currentPath}/${segments[i]}` : segments[i]!
      ancestorKeys.push(currentPath)
    }
    const missingKeys = ancestorKeys.filter(key => !view.expandedKeys.includes(key))
    if (!missingKeys.length)
      return
    view.expandedKeys = [...view.expandedKeys, ...missingKeys]
    for (const key of missingKeys) {
      if (!retained(value.id, view, generation))
        return
      try {
        const children = await readNodes(value, key, view)
        if (retained(value.id, view, generation))
          view.nodes = replaceChildren(view.nodes, key, children)
      }
      catch {}
    }
  })

  function retained(id: string, view: FileView, generation = view.generation): boolean {
    return !disposed && hasTab(id) && views.get(id) === view && generation === view.generation
  }

  async function readNodes(value: TaskFilesContextTab, path: string, view: FileView): Promise<TreeOption[]> {
    const generation = view.generation
    const nodes: TreeOption[] = []
    let cursor: string | undefined
    do {
      const page = await api.listDirectory({ ...value.target, path, cursor })
      if (!retained(value.id, view, generation))
        return []
      nodes.push(...page.entries.map(entry => ({
        key: entry.path,
        label: entry.name,
        kind: entry.kind,
        isLeaf: entry.kind === 'file',
        disabled: entry.unavailable,
        writable: entry.writable !== false,
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
    const generation = view.generation
    try {
      const children = await readNodes(value, String(node.key), view)
      if (node.writable === false)
        children.forEach(child => child.writable = false)
      if (retained(value.id, view, generation)) {
        view.nodes = replaceChildren(view.nodes, node.key!, children)
        view.treeFailed = false
      }
    }
    catch {
      if (retained(value.id, view, generation))
        view.treeFailed = true
    }
  }

  async function refresh(targetTab?: TaskFilesContextTab | null): Promise<boolean> {
    const value = targetTab ?? tab.value
    if (!value)
      return false
    const view = views.get(value.id)
    if (!view)
      return false
    const generation = ++view.generation
    try {
      let rootNodes = await readNodes(value, '', view)
      if (!retained(value.id, view, generation))
        return false
      const validExpandedKeys: Array<string | number> = []
      const sortedKeys = [...view.expandedKeys].sort((a, b) => {
        const depthA = String(a).split('/').filter(Boolean).length
        const depthB = String(b).split('/').filter(Boolean).length
        return depthA - depthB
      })
      for (const key of sortedKeys) {
        if (!retained(value.id, view, generation))
          return false
        try {
          const children = await readNodes(value, String(key), view)
          rootNodes = replaceChildren(rootNodes, key, children)
          validExpandedKeys.push(key)
        }
        catch {
          // Skip missing or unreadable directories
        }
      }
      if (retained(value.id, view, generation)) {
        view.nodes = rootNodes
        view.expandedKeys = validExpandedKeys
        view.treeFailed = false
        view.stale = false
        return true
      }
    }
    catch {
      if (retained(value.id, view, generation)) {
        view.treeFailed = true
        view.stale = true
      }
    }
    return false
  }

  let lastFocusSync = 0
  function handleFocus() {
    if (disposed || !tab.value)
      return
    const now = Date.now()
    if (now - lastFocusSync < 2000)
      return
    lastFocusSync = now
    void refresh()
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('focus', handleFocus)
    onScopeDispose(() => {
      window.removeEventListener('focus', handleFocus)
    })
  }

  function expand(tabId: string, path: string) {
    const view = views.get(tabId)
    if (!view || !path)
      return
    const segments = path.split('/')
    const keys = segments.map((_, index) => segments.slice(0, index + 1).join('/'))
    view.expandedKeys = [...new Set([...view.expandedKeys, ...keys])]
  }

  return { current, load, refresh, expand }
}

function replaceChildren(nodes: TreeOption[], key: string | number, children: TreeOption[]): TreeOption[] {
  return nodes.map(node => node.key === key
    ? { ...node, children: node.writable === false ? children.map(child => ({ ...child, writable: false })) : children }
    : node.children ? { ...node, children: replaceChildren(node.children, key, children) } : node)
}
