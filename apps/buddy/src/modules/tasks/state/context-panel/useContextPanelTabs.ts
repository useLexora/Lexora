import type { DesktopContextPanelMode } from '@buddy-electron/shared/desktopApi'
import type { Ref } from 'vue'
import type { ContextPanelScope, ContextPanelSelectionScope, TaskContextTab } from '../../model/context-panel/taskContextPanel'
import { computed, readonly, shallowReactive, shallowRef, watch } from 'vue'
import { contextPanelSelectionScope, taskContextPanelScope } from '../../model/context-panel/taskContextPanel'

export function useContextPanelTabs(options: {
  mode: Readonly<Ref<DesktopContextPanelMode>>
  scopeSpaceIds: Readonly<Ref<ReadonlyMap<string, string | null>>>
  conversationId: Readonly<Ref<string | null>>
  draftId: Readonly<Ref<string | null>>
}) {
  const resources = shallowRef<readonly TaskContextTab[]>([])
  const selections = shallowReactive(new Map<ContextPanelSelectionScope, string>())
  const discardedScopes = new Set<ContextPanelScope>()
  const taskScope = computed<ContextPanelScope>(() => options.conversationId.value
    ? taskContextPanelScope(options.conversationId.value)
    : options.draftId.value ? `draft:${options.draftId.value}` : 'workspace')
  const scope = computed<ContextPanelScope>(() => options.mode.value === 'independent' ? 'independent' : taskScope.value)
  const selectionScope = computed(() => selectionFor(taskScope.value))
  const tabs = computed(() => scopeTabs(selectionScope.value))
  const activeTab = computed(() => selectedTab(selectionScope.value))

  watch(options.mode, (mode, previousMode) => {
    const previous = selectedTab(selectionFor(taskScope.value, previousMode))
    if (previous && tabs.value.some(tab => tab.id === previous.id)
      && (mode === 'independent' || !selections.has(selectionScope.value))) {
      selections.set(selectionScope.value, previous.id)
    }
  }, { flush: 'sync' })
  watch([selectionScope, tabs], ([scope]) => {
    const tab = activeTab.value
    if (tab && scope.startsWith('space:') && selections.get(scope) !== tab.id)
      selections.set(scope, tab.id)
  }, { flush: 'sync' })

  function selectionFor(scope: ContextPanelScope, mode = options.mode.value) {
    return contextPanelSelectionScope(mode, scope, options.scopeSpaceIds.value)
  }
  function adoptDraft(draftId: string, conversationId: string) {
    const draftScope: ContextPanelScope = `draft:${draftId}`
    const destination = taskContextPanelScope(conversationId)
    if (discardedScopes.has(destination) || !resources.value.some(tab => tab.scope === draftScope))
      return
    resources.value = resources.value.map(tab => tab.scope === draftScope ? { ...tab, scope: destination } : tab)
    const selected = selections.get(draftScope)
    if (selected && !selections.has(destination))
      selections.set(destination, selected)
    selections.delete(draftScope)
  }

  function scopeTabs(scope: ContextPanelSelectionScope) {
    if (scope === 'independent')
      return resources.value
    return resources.value.filter(tab => scope.startsWith('space:') ? selectionFor(tab.scope, 'space') === scope : tab.scope === scope)
  }

  function selectedTab(scope: ContextPanelSelectionScope) {
    const tabs = scopeTabs(scope)
    return tabs.find(tab => tab.id === selections.get(scope)) ?? tabs.at(-1) ?? null
  }

  function select(id: string) {
    if (tabs.value.some(tab => tab.id === id))
      selections.set(selectionScope.value, id)
  }

  function put(tab: TaskContextTab, activate = true) {
    if (discardedScopes.has(tab.scope))
      return
    resources.value = resources.value.some(item => item.id === tab.id)
      ? resources.value.map(item => item.id === tab.id ? tab : item)
      : [...resources.value, tab]
    if (activate)
      selections.set(selectionFor(tab.scope), tab.id)
  }

  function close(id: string) {
    for (const [key, selected] of selections) {
      if (selected !== id)
        continue
      const tabs = scopeTabs(key)
      const index = tabs.findIndex(tab => tab.id === id)
      const next = tabs[index + 1] ?? tabs[index - 1]
      if (next)
        selections.set(key, next.id)
      else
        selections.delete(key)
    }
    resources.value = resources.value.filter(tab => tab.id !== id)
  }

  function update(transform: (tab: TaskContextTab) => TaskContextTab) {
    resources.value = resources.value.map(transform)
  }

  function retain(predicate: (tab: TaskContextTab) => boolean) {
    for (const tab of resources.value) {
      if (!predicate(tab))
        close(tab.id)
    }
  }

  function discard(scope: ContextPanelScope) {
    const removed = resources.value.filter(tab => tab.scope === scope)
    discardedScopes.add(scope)
    retain(tab => tab.scope !== scope)
    selections.delete(scope)
    return removed
  }

  function discardDraft(draftId: string) {
    const draftScope: ContextPanelScope = `draft:${draftId}`
    if (options.mode.value === 'independent') {
      resources.value = resources.value.map(tab => tab.scope === draftScope ? { ...tab, scope: 'independent' } : tab)
      selections.delete(draftScope)
      discardedScopes.add(draftScope)
      return []
    }
    return discard(draftScope)
  }

  function snapshot() {
    return { tabs: resources.value, selections: [...selections] }
  }
  function restoreSelections(values: readonly (readonly [ContextPanelSelectionScope, string])[]) {
    for (const [scope, id] of values) {
      if (resources.value.some(tab => tab.id === id))
        selections.set(scope, id)
    }
  }

  return { snapshot, restoreSelections, activeTab: readonly(activeTab), tabs: readonly(tabs), resources: readonly(resources), scope: readonly(scope), select, put, close, update, retain, discard, discardDraft, adoptDraft }
}
