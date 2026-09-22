import type { LocalArtifact } from '@buddy-shared/artifacts/artifactApi'
import type { LocalChangeSetSummary } from '@buddy-shared/changes/changeApi'
import type { ContextPanelSource } from '@buddy-shared/context-panel/contextPanel'
import type { ArtifactViewMode, TaskContextTab } from '../../model/context-panel/taskContextPanel'
import type { UseTaskContextPanelOptions } from './typing'
import { computed, readonly, watch } from 'vue'
import { useContextPanelControl } from '@/platform/desktop/useContextPanelControl'
import { readContextSelection, readContextTab } from '../../model/context-panel/readContextTab'
import { artifactTabId, browserTabId, contextTabSource, spaceTaskBrowserTab, taskContextPanelScope } from '../../model/context-panel/taskContextPanel'
import { resolveChatToolFileTarget } from '../../model/transcript/chatToolFileTarget'
import { useContextPanelTabs } from './useContextPanelTabs'

export function useTaskContextPanel(options: UseTaskContextPanelOptions) {
  const store = useContextPanelTabs({ mode: options.mode, conversationId: options.activeConversationId, draftId: options.activeDraftId })
  const control = useContextPanelControl({
    api: options.control,
    getSource: () => contextTabSource(store.activeTab.value)
      ?? (options.mode.value === 'task' && options.taskVisible.value ? currentSource() ?? null : null),
    onError: options.onError,
    onTarget: (target) => {
      const tab = spaceTaskBrowserTab(target.source.conversationId)
      if (tab)
        store.put({ ...tab, source: target.source }, options.taskVisible.value && target.source.conversationId === options.activeConversationId.value)
    },
  })
  const fileSpaces = computed(() => options.spaces.value.filter(space => space.revokedAt === null
    && space.primaryDirectory && space.primaryDirectory.revokedAt === null))
  const currentFileSpace = computed(() => fileSpaces.value.find(space => space.id === options.activeSpace?.value?.id) ?? null)
  const fileEntry = computed(() => {
    if (options.mode.value === 'independent')
      return { kind: 'space-picker' as const }
    return options.taskVisible.value && currentFileSpace.value
      ? { kind: 'directory' as const, spaceId: currentFileSpace.value.id }
      : null
  })
  const canAddChanges = computed(() => options.mode.value === 'task' && options.taskVisible.value
    && Boolean(options.activeConversationId.value)
    && !store.tabs.value.some(tab => tab.kind === 'changes' && tab.conversationId === options.activeConversationId.value))
  const changeRevision = computed(() => options.changeSets.value.filter(set => set.conversationId === options.activeConversationId.value)
    .map(set => `${set.changeSetId}:${set.updatedAt}`)
    .join('|'))

  watch(options.spaces, () => store.retain(isAvailable))
  watch([changeRevision, options.activeBranchId, options.activeConversationId, options.mode], ([revision, branchId]) => {
    store.update((tab) => {
      if (tab.kind !== 'changes' || tab.conversationId !== options.activeConversationId.value)
        return tab
      if (tab.branchId !== branchId)
        return options.mode.value === 'task' ? { ...tab, branchId, revision, changeSet: null, source: currentSource() } : tab
      return tab.revision !== revision ? { ...tab, revision } : tab
    })
  })

  function openTab(tab: TaskContextTab) {
    store.put(tab)
    void control.open()
  }

  function currentSource(): ContextPanelSource | undefined {
    const conversationId = options.activeConversationId.value
    const runId = options.activeRunId.value
    return conversationId && runId ? { conversationId, runId } : undefined
  }

  function openArtifact(target: string | LocalArtifact) {
    const artifact = typeof target === 'string'
      ? options.runOutputs.value.flatMap(output => output.artifacts).find(item => item.artifactId === target)
      : target
    if (!artifact)
      return
    const id = artifactTabId(artifact.artifactId)
    const previous = store.resources.value.find(tab => tab.id === id)
    openTab({ artifact, id, scope: taskContextPanelScope(artifact.conversationId), kind: 'artifact', label: artifact.name, viewMode: previous?.kind === 'artifact' ? previous.viewMode : 'preview' })
  }

  function setArtifactViewMode(tabId: string, viewMode: ArtifactViewMode) {
    store.update(tab => tab.id === tabId && tab.kind === 'artifact' ? { ...tab, viewMode } : tab)
  }

  function openBrowser(source = currentSource()) {
    const tab = spaceTaskBrowserTab(source?.conversationId ?? options.activeConversationId.value)
    if (tab)
      openTab({ ...tab, source })
  }

  function openChanges(target?: string | LocalChangeSetSummary) {
    const conversationId = options.activeConversationId.value
    if (!conversationId)
      return
    const changeSet = typeof target === 'string'
      ? options.changeSets.value.find(set => set.changeSetId === target)
      : target
    if (target && (!changeSet || changeSet.conversationId !== conversationId))
      return
    openTab({
      id: `changes:${conversationId}`,
      scope: taskContextPanelScope(conversationId),
      kind: 'changes',
      conversationId,
      branchId: options.activeBranchId.value,
      revision: changeRevision.value,
      changeSet: changeSet ?? null,
      source: currentSource(),
    })
  }

  function addBrowser() {
    const browserKey = crypto.randomUUID()
    openTab({ id: browserTabId(null, browserKey), scope: store.scope.value, kind: 'browser', conversationId: null, browserKey })
  }

  function openFiles(spaceId: string) {
    const space = fileSpaces.value.find(space => space.id === spaceId)
    const directory = space?.primaryDirectory
    if (!space || !directory)
      return
    openTab({
      id: `files:${crypto.randomUUID()}`,
      scope: store.scope.value,
      kind: 'files',
      rootName: directory.root.split(/[\\/]/).filter(Boolean).at(-1) ?? directory.root,
      target: { spaceId: space.id, directoryId: directory.id, revision: directory.revision, path: '' },
      source: options.mode.value === 'task' ? currentSource() : undefined,
    })
  }

  function selectFile(tabId: string, path: string) {
    store.update(tab => tab.id === tabId && tab.kind === 'files' ? { ...tab, target: { ...tab.target, path } } : tab)
  }

  function canPreviewFile(path: string) {
    return Boolean(resolveChatToolFileTarget(options.activeSpace?.value ?? null, path))
  }

  function previewFile(path: string) {
    const space = options.activeSpace?.value ?? null
    const target = resolveChatToolFileTarget(space, path)
    if (!target || !space?.primaryDirectory)
      return

    const exactTab = store.tabs.value.find(tab =>
      tab.kind === 'files'
      && tab.target.spaceId === target.spaceId
      && tab.target.directoryId === target.directoryId
      && tab.target.path === target.path,
    )
    if (exactTab) {
      store.select(exactTab.id)
      void control.open()
      return
    }

    const active = store.activeTab.value
    const spaceTab = (active?.kind === 'files' && active.target.spaceId === target.spaceId && active.target.directoryId === target.directoryId)
      ? active
      : store.tabs.value.find(tab =>
          tab.kind === 'files'
          && tab.target.spaceId === target.spaceId
          && tab.target.directoryId === target.directoryId,
        )

    if (spaceTab) {
      selectFile(spaceTab.id, target.path)
      store.select(spaceTab.id)
      void control.open()
      return
    }

    openTab({
      id: `files:${store.scope.value}:${target.spaceId}:${target.directoryId}:preview`,
      scope: store.scope.value,
      kind: 'files',
      rootName: space.primaryDirectory.root.split(/[\\/]/).filter(Boolean).at(-1) ?? space.primaryDirectory.root,
      target,
      source: currentSource(),
    })
  }

  function isAvailable(tab: TaskContextTab): boolean {
    if (tab.kind !== 'files')
      return true
    const directory = fileSpaces.value.find(space => space.id === tab.target.spaceId)?.primaryDirectory
    return Boolean(directory && tab.target.directoryId === directory.id && tab.target.revision === directory.revision)
  }

  function hasTab(id: string) {
    return store.resources.value.some(tab => tab.id === id)
  }

  function restoreTab(value: unknown) {
    const tab = readContextTab(value)
    if (tab && isAvailable(tab) && !hasTab(tab.id))
      store.put(tab, false)
  }

  return {
    restoreSnapshot(value: unknown) {
      if (!value || typeof value !== 'object')
        return
      const snapshot = value as { tabs?: unknown, selections?: unknown }
      if (Array.isArray(snapshot.tabs))
        snapshot.tabs.slice(0, 512).forEach(restoreTab)
      if (Array.isArray(snapshot.selections)) {
        for (const selection of snapshot.selections) {
          const parsed = readContextSelection(selection)
          if (parsed)
            store.restoreSelections([parsed])
        }
      }
    },
    snapshot: store.snapshot,
    restoreSelections: store.restoreSelections,
    openView: (viewId: string, label: string) => openTab({ kind: 'view', id: viewId, viewId, label, scope: store.scope.value }),
    updateView: (viewId: string, label: string) => store.update(tab => tab.kind === 'view' && tab.viewId === viewId && tab.label !== label ? { ...tab, label } : tab),
    removeView: store.close,
    allTabs: store.resources,
    activeTab: store.activeTab,
    tabs: store.tabs,
    isOpen: control.isOpen,
    mode: options.mode,
    fileEntry: readonly(fileEntry),
    fileSpaces: readonly(fileSpaces),
    canAddChanges: readonly(canAddChanges),
    adoptDraft: store.adoptDraft,
    discardDraft: store.discardDraft,
    addBrowser,
    canPreviewFile,
    closeTab: store.close,
    discardConversation: (id: string) => store.discard(taskContextPanelScope(id)),
    hasTab,
    openArtifact,
    openBrowser,
    openChanges,
    openFiles,
    previewFile,
    selectFile,
    setArtifactViewMode,
    restoreTab,
    selectTab: store.select,
    toggle: control.toggle,
  }
}
