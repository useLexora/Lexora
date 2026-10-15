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
  loadingKeys: Set<string>
  requests: Map<string, Promise<void>>
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
    if (!view || view.tab.target.directoryId !== value.target.directoryId || view.tab.target.revision !== value.target.revision || view.tab.target.spaceId !== value.target.spaceId) {
      view = shallowReactive<FileView>({ generation: 0, tab: value, nodes: [], expandedKeys: [], treeVisible: true, treeWidth: 220, wrap: false, treeFailed: false, loadingKeys: shallowReactive(new Set<string>()), requests: new Map() })
      views.set(value.id, view)
      void refresh(value)
    }
    view.tab = value
  }, { immediate: true, flush: 'sync' })

  watch(() => [tab.value?.id, tab.value?.target.path], async (_, __, onCleanup) => {
    const value = tab.value
    const view = current.value
    if (!value?.target.path || !view)
      return
    let active = true
    onCleanup(() => active = false)
    await view.requests.get('')
    const segments = value.target.path.split('/').filter(Boolean)
    let path = ''
    for (const segment of segments.slice(0, -1)) {
      if (!active || !retained(value.id, view))
        return
      path = path ? `${path}/${segment}` : segment
      const node = findNode(view.nodes, path)
      if (!node || node.kind !== 'directory' || node.disabled)
        return
      if (!view.expandedKeys.includes(path))
        view.expandedKeys = [...view.expandedKeys, path]
      if (!node.children || view.loadingKeys.has(path))
        await readNodes(value, path, view)
    }
  }, { immediate: true })

  function retained(id: string, view: FileView): boolean {
    return !disposed && hasTab(id) && views.get(id) === view
  }

  function findNode(nodes: readonly ExplorerNode[], path: string): ExplorerNode | undefined {
    let key = ''
    let node: ExplorerNode | undefined
    for (const segment of path.split('/')) {
      key = key ? `${key}/${segment}` : segment
      node = nodes.find(node => node.key === key)
      nodes = node?.children ?? []
    }
    return node
  }

  function readNodes(value: TaskFilesContextTab, path: string, view: FileView): Promise<void> {
    const pending = view.requests.get(path)
    if (pending)
      return pending
    const generation = view.generation
    const active = () => retained(value.id, view) && generation === view.generation
    view.loadingKeys.add(path)
    const request = (async () => {
      const previous = path ? findNode(view.nodes, path)?.children ?? [] : view.nodes
      const previousByKey = new Map(previous.map(node => [node.key, node]))
      const nodes: ExplorerNode[] = []
      const cursors = new Set<string>()
      let cursor: string | undefined
      do {
        const page = await api.listDirectory({ ...value.target, path, cursor })
        if (!active())
          return
        nodes.push(...page.entries.map((entry) => {
          const old = previousByKey.get(entry.path)
          return {
            key: entry.path,
            label: entry.name,
            kind: entry.kind,
            disabled: entry.unavailable,
            children: entry.kind === 'directory' && !entry.unavailable && view.expandedKeys.includes(entry.path) ? old?.children : undefined,
          }
        }))
        const currentNodes = new Map((path ? findNode(view.nodes, path)?.children ?? [] : view.nodes).map(node => [node.key, node]))
        const visibleNodes = nodes.map(node => node.kind === 'directory' && !node.disabled && view.expandedKeys.includes(node.key)
          ? { ...node, children: currentNodes.get(node.key)?.children ?? node.children }
          : node)
        view.nodes = path ? replaceChildren(view.nodes, path, visibleNodes) : visibleNodes
        cursor = page.nextCursor ?? undefined
        if (cursor && cursors.has(cursor))
          throw new Error('FILE_LIST_CHANGED')
        if (cursor)
          cursors.add(cursor)
      } while (cursor)
    })().catch(() => {
      if (active())
        view.treeFailed = true
    }).finally(() => {
      if (active()) {
        view.loadingKeys.delete(path)
        view.requests.delete(path)
      }
    })
    view.requests.set(path, request)
    return request
  }

  async function load(node: ExplorerNode): Promise<void> {
    const value = tab.value
    const view = current.value
    if (value && view) {
      const generation = view.generation
      await readNodes(value, node.key, view)
      await loadExpanded(value, view, generation, node.key)
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
    view.requests.clear()
    view.loadingKeys.clear()
    view.treeFailed = false
    await readNodes(value, '', view)
    await loadExpanded(value, view, generation)
  }

  async function loadExpanded(value: TaskFilesContextTab, view: FileView, generation: number, parent = ''): Promise<void> {
    const sortedKeys = view.expandedKeys.filter(key => !parent || key.startsWith(`${parent}/`)).sort((a, b) => a.split('/').length - b.split('/').length)
    for (const key of sortedKeys) {
      if (!retained(value.id, view) || generation !== view.generation)
        return
      const segments = key.split('/')
      const visible = segments.slice(0, -1).every((_, index) => view.expandedKeys.includes(segments.slice(0, index + 1).join('/')))
      if (!view.expandedKeys.includes(key) || !visible)
        continue
      const node = findNode(view.nodes, key)
      if (node?.kind === 'directory' && !node.disabled) {
        await readNodes(value, key, view)
      }
      else if (!view.treeFailed) {
        view.expandedKeys = view.expandedKeys.filter(path => path !== key && !path.startsWith(`${key}/`))
      }
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
        if (retained(id, view))
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
