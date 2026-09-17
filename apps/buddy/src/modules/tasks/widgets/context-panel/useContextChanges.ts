import type { ChangeOverviewRequest, LocalChangeOverview, LocalChangeSetDetail } from '@buddy-shared/changes/changeApi'
import type { Ref } from 'vue'
import type { ChangeFilePresentation } from './changeContextPresentation'
import type { TaskChangesContextTab } from '@/modules/tasks/model/context-panel/taskContextPanel'
import { computed, onScopeDispose, shallowReactive, watch, watchEffect } from 'vue'
import { buildChangeFileTree, presentChangeFiles } from './changeContextPresentation'

interface ChangesView {
  source: TaskChangesContextTab
  range: 'all' | 'turn'
  treeVisible: boolean
  treeWidth: number
  expandedKeys: Array<string | number>
  collapsedFiles: ReadonlySet<string>
  selectedFileId: string | null
  wrap: boolean
  sideBySide: boolean
  detail: (Omit<LocalChangeOverview, 'files'> & { files: ChangeFilePresentation[] }) | null
  loadedScope: string | null
  loading: boolean
  failed: boolean
}

export function useContextChanges(options: {
  hasTab: (id: string) => boolean
  tab: Readonly<Ref<TaskChangesContextTab | null>>
  getOverview: (input: ChangeOverviewRequest) => Promise<LocalChangeOverview>
  getChangeSet: (id: string) => Promise<LocalChangeSetDetail>
}) {
  const views = shallowReactive(new Map<string, ChangesView>())
  watchEffect(() => {
    for (const id of views.keys()) {
      if (!options.hasTab(id))
        views.delete(id)
    }
  })
  onScopeDispose(() => views.clear())
  const current = computed(() => options.tab.value ? views.get(options.tab.value.id) ?? null : null)
  watch(options.tab, (tab) => {
    if (!tab)
      return
    const previous = views.get(tab.id)
    if (!previous) {
      views.set(tab.id, shallowReactive({
        source: tab,
        range: tab.changeSet ? 'turn' : 'all',
        treeVisible: true,
        treeWidth: 220,
        expandedKeys: [],
        collapsedFiles: new Set<string>(),
        selectedFileId: null,
        wrap: false,
        sideBySide: false,
        detail: null,
        loadedScope: null,
        loading: true,
        failed: false,
      }))
    }
    else if (previous.source !== tab) {
      if (previous.source.changeSet?.changeSetId !== tab.changeSet?.changeSetId)
        previous.range = tab.changeSet ? 'turn' : 'all'
      previous.source = tab
    }
  }, { immediate: true, flush: 'sync' })
  watch([options.tab, () => current.value?.range], async ([tab], _previous, onCleanup) => {
    const view = current.value
    if (!tab || !view)
      return
    const branchId = tab.branchId
    const changeSetId = view.range === 'turn' ? tab.changeSet?.changeSetId : null
    if (!changeSetId && !branchId) {
      view.loading = false
      return
    }
    let active = true
    onCleanup(() => {
      active = false
    })
    const scope = view.range === 'turn' ? `turn:${tab.changeSet?.changeSetId}` : `all:${branchId}`
    if (view.loadedScope !== scope) {
      view.detail = null
      view.loadedScope = scope
    }
    view.loading = !view.detail
    view.failed = false
    try {
      const result = changeSetId
        ? await options.getChangeSet(changeSetId)
        : await options.getOverview({ conversationId: tab.conversationId, branchId: branchId! })
      if (!active)
        return
      view.detail = { ...result, files: presentChangeFiles(result.files, view.detail?.files ?? []) }
      if (!result.files.some(file => file.id === view.selectedFileId))
        view.selectedFileId = result.files[0]?.id ?? null
      const ids = new Set(result.files.map(file => file.id))
      view.collapsedFiles = new Set([...view.collapsedFiles].filter(id => ids.has(id)))
      if (!view.expandedKeys.length)
        view.expandedKeys = collectDirectories(buildChangeFileTree(view.detail.files))
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
  const nodes = computed(() => buildChangeFileTree(current.value?.detail?.files ?? []))
  const counts = computed(() => (current.value?.detail?.files ?? []).reduce((total, file) => {
    const count = file.lineCounts ?? { added: 0, deleted: 0 }
    return { added: total.added + count.added, deleted: total.deleted + count.deleted }
  }, { added: 0, deleted: 0 }))
  function toggleFile(id: string) {
    const view = current.value
    if (!view)
      return
    const next = new Set(view.collapsedFiles)
    if (next.has(id))
      next.delete(id)
    else next.add(id)
    view.collapsedFiles = next
  }
  function toggleAll() {
    const view = current.value
    if (!view)
      return
    view.collapsedFiles = view.detail?.files.every(file => view.collapsedFiles.has(file.id))
      ? new Set()
      : new Set(view.detail?.files.map(file => file.id))
  }
  return { current, nodes, counts, toggleFile, toggleAll }
}

function collectDirectories(nodes: ReturnType<typeof buildChangeFileTree>): Array<string | number> {
  return nodes.flatMap(node => node.kind === 'directory' ? [node.key!, ...collectDirectories(node.children ?? [])] : [])
}
