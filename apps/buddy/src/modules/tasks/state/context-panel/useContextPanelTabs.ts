import type { DesktopContextPanelMode } from '@buddy-electron/shared/desktopApi'
import type { Ref } from 'vue'
import type { ContextPanelScope, TaskContextTab } from '../../model/context-panel/taskContextPanel'
import { computed, readonly, shallowReactive, shallowRef, watch } from 'vue'
import { taskContextPanelScope } from '../../model/context-panel/taskContextPanel'

export function useContextPanelTabs(options: {
  mode: Readonly<Ref<DesktopContextPanelMode>>
  conversationId: Readonly<Ref<string | null>>
  draftId: Readonly<Ref<string>>
}) {
  const resources = shallowRef<readonly TaskContextTab[]>([])
  const selections = shallowReactive(new Map<ContextPanelScope, string>())
  const discardedScopes = new Set<ContextPanelScope>()
  const taskScope = computed<ContextPanelScope>(() => options.conversationId.value
    ? taskContextPanelScope(options.conversationId.value)
    : `draft:${options.draftId.value}`)
  const scope = computed<ContextPanelScope>(() => options.mode.value === 'independent' ? 'independent' : taskScope.value)
  const tabs = computed(() => scopeTabs(scope.value))
  const activeTab = computed(() => selectedTab(scope.value))

  watch(options.mode, (mode) => {
    if (mode === 'independent') {
      const previous = selectedTab(taskScope.value)
      if (previous)
        selections.set('independent', previous.id)
    }
  }, { flush: 'sync' })
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

  function scopeTabs(scope: ContextPanelScope) {
    return scope === 'independent' ? resources.value : resources.value.filter(tab => tab.scope === scope)
  }

  function selectedTab(scope: ContextPanelScope) {
    const tabs = scopeTabs(scope)
    return tabs.find(tab => tab.id === selections.get(scope)) ?? tabs.at(-1) ?? null
  }

  function select(id: string) {
    if (tabs.value.some(tab => tab.id === id))
      selections.set(scope.value, id)
  }

  function put(tab: TaskContextTab, activate = true) {
    if (discardedScopes.has(tab.scope))
      return
    resources.value = resources.value.some(item => item.id === tab.id)
      ? resources.value.map(item => item.id === tab.id ? tab : item)
      : [...resources.value, tab]
    if (activate)
      selections.set(options.mode.value === 'independent' ? 'independent' : tab.scope, tab.id)
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

  return { activeTab: readonly(activeTab), tabs: readonly(tabs), resources: readonly(resources), scope: readonly(scope), select, put, close, update, retain, discard, adoptDraft }
}
