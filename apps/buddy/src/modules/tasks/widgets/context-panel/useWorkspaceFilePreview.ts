import type { LocalChatApi } from '@buddy-electron/shared/localChatApi'
import type { Ref } from 'vue'
import type { TaskFilesContextTab } from '@/modules/tasks/model/context-panel/taskContextPanel'
import type { ExplorerNode } from '@/shared/ui/explorer/treeCollection'
import { computed, onScopeDispose, shallowReactive, watch, watchEffect } from 'vue'
import { replaceChildren } from '@/shared/ui/explorer/treeCollection'

export type WorkspaceFilesApi = Pick<LocalChatApi['spaces'], 'listDirectory' | 'readFile' | 'revealFile' | 'fileHistory' | 'acknowledgeFileOperation' | 'cancelFileOperation' | 'onFilesChanged'>
interface FileView {
  generation: number
  tab: TaskFilesContextTab
  nodes: ExplorerNode[]
  expandedKeys: string[]
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
      view = shallowReactive<FileView>({ generation: 0, tab: value, nodes: [], expandedKeys: [], treeVisible: true, treeWidth: 220, wrap: false, treeFailed: false })
      views.set(value.id, view)
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
      if (!retained(value.id, view))
        return
      try {
        const children = await readNodes(value, key, view)
        if (retained(value.id, view))
          view.nodes = replaceChildren(view.nodes, key, children)
      }
      catch {}
    }
  }, { immediate: true })

  function retained(id: string, view: FileView): boolean {
    return !disposed && hasTab(id) && views.get(id) === view
  }

  async function readNodes(value: TaskFilesContextTab, path: string, view: FileView): Promise<ExplorerNode[]> {
    const nodes: ExplorerNode[] = []
    const cursors = new Set<string>()
    let cursor: string | undefined
    do {
      const page = await api.listDirectory({ ...value.target, path, cursor })
      if (!retained(value.id, view))
        return []
      nodes.push(...page.entries.map(entry => ({
        key: entry.path,
        label: entry.name,
        kind: entry.kind,
        disabled: entry.unavailable,
      })))
      cursor = page.nextCursor ?? undefined
      if (cursor && cursors.has(cursor))
        throw new Error('FILE_LIST_CHANGED')
      if (cursor)
        cursors.add(cursor)
    } while (cursor)
    return nodes
  }

  async function load(node: ExplorerNode): Promise<void> {
    const value = tab.value
    const view = current.value
    if (!value || !view)
      return
    const generation = view.generation
    try {
      const children = await readNodes(value, String(node.key), view)
      if (retained(value.id, view) && view.generation === generation) {
        view.nodes = replaceChildren(view.nodes, node.key!, children)
        view.treeFailed = false
      }
    }
    catch {
      if (retained(value.id, view) && generation === view.generation)
        view.treeFailed = true
    }
  }

  async function refresh(targetTab?: TaskFilesContextTab | null): Promise<void> {
    const value = targetTab ?? tab.value
    if (!value)
      return
    const view = views.get(value.id)
    if (!view)
      return
    const generation = ++view.generation
    try {
      let rootNodes = await readNodes(value, '', view)
      if (!retained(value.id, view))
        return
      const validExpandedKeys: string[] = []
      const expandedAtStart = [...view.expandedKeys]
      const sortedKeys = [...expandedAtStart].sort((a, b) => {
        const depthA = String(a).split('/').filter(Boolean).length
        const depthB = String(b).split('/').filter(Boolean).length
        return depthA - depthB
      })
      for (const key of sortedKeys) {
        if (!retained(value.id, view))
          return
        try {
          const children = await readNodes(value, String(key), view)
          rootNodes = replaceChildren(rootNodes, key, children)
          validExpandedKeys.push(key)
        }
        catch {
          // Skip missing or unreadable directories
        }
      }
      if (retained(value.id, view) && generation === view.generation) {
        if (expandedAtStart.length !== view.expandedKeys.length || expandedAtStart.some((key, index) => view.expandedKeys[index] !== key))
          return refresh(value)
        view.nodes = rootNodes
        view.expandedKeys = validExpandedKeys
        view.treeFailed = false
      }
    }
    catch {
      if (retained(value.id, view) && generation === view.generation)
        view.treeFailed = true
    }
  }

  const refreshTimers = new Map<string, ReturnType<typeof setTimeout>>()
  onScopeDispose(api.onFilesChanged((event) => {
    for (const [id, view] of views) {
      if (view.tab.target.directoryId !== event.directoryId || view.tab.target.revision !== event.directoryRevision)
        continue
      clearTimeout(refreshTimers.get(id))
      refreshTimers.set(id, setTimeout(() => {
        refreshTimers.delete(id)
        void refresh(view.tab)
      }, 200))
    }
  }))
  onScopeDispose(() => {
    for (const timer of refreshTimers.values()) clearTimeout(timer)
  })

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

  return { current, load, refresh }
}
