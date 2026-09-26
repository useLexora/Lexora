import type { ExtensionStatus } from '@buddy-shared/extensions/extensionApi'
import type { WorkbenchUiSelectionTarget } from '@buddy-shared/workbench/workbenchUi'
import type { Ref } from 'vue'
import type { ConfigurationService } from '@/workbench/services/ConfigurationService'
import { parseWorkbenchUiSelection, workbenchUiSelectionKey, workbenchUiTargetCatalog } from '@buddy-shared/workbench/workbenchUi'
import { computed, onScopeDispose, shallowRef } from 'vue'

export function useExtensionUiContributions(installed: Readonly<Ref<ExtensionStatus[]>>, configuration: ConfigurationService) {
  const revision = shallowRef(0)
  onScopeDispose(configuration.subscribe(() => revision.value++))
  const entries = computed(() => {
    void revision.value
    return workbenchUiTargetCatalog.map(target => ({
      ...target,
      selected: parseWorkbenchUiSelection(configuration.get(workbenchUiSelectionKey(target)), target.selection === 'multiple') ?? [],
      providers: installed.value.filter(plugin => plugin.enabled && plugin.compatible)
        .flatMap(plugin => plugin.manifest.contributes.placements.flatMap(placement => (placement.kind === 'control' || placement.kind === 'slot') && placement.kind === target.kind && placement.target === target.target ? [{ plugin, placement, title: plugin.manifest.contributes.views.find(view => view.id === placement.view)?.title ?? plugin.manifest.name }] : []))
        .sort((left, right) => left.placement.id.localeCompare(right.placement.id)),
    }))
  })
  function entry(target: WorkbenchUiSelectionTarget) {
    return entries.value.find(entry => entry.kind === target.kind && entry.target === target.target)!
  }
  function selected(target: WorkbenchUiSelectionTarget) {
    const current = entry(target)
    return current.selected.flatMap(id => current.providers.filter(provider => provider.placement.id === id))
  }
  function choose(target: WorkbenchUiSelectionTarget, ids: string[]): void {
    const current = entry(target)
    const multiple = current.selection === 'multiple'
    const value = multiple ? JSON.stringify(ids) : ids[0] ?? ''
    if ((!multiple && ids.length > 1) || !parseWorkbenchUiSelection(value, multiple) || ids.some(id => !current.selected.includes(id) && !current.providers.some(provider => provider.placement.id === id)))
      return
    configuration.set(workbenchUiSelectionKey(target), value)
  }
  return { entries, selected, choose }
}
