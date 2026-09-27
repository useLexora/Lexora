import type { ExtensionStatus } from '@buddy-shared/extensions/extensionApi'
import type { WorkbenchUiSelectionTarget } from '@buddy-shared/workbench/workbenchUi'
import type { Ref } from 'vue'
import type { ConfigurationService } from '@/workbench/services/ConfigurationService'
import { parseWorkbenchUiSelection, workbenchUiSelectionKey, workbenchUiTargetCatalog } from '@buddy-shared/workbench/workbenchUi'
import { computed, onScopeDispose, shallowReactive, shallowRef, watch } from 'vue'

export function useExtensionUiContributions(installed: Readonly<Ref<ExtensionStatus[]>>, configuration: ConfigurationService) {
  const revision = shallowRef(0)
  const overrides = shallowReactive(new Map<string, { extensionId: string, generation: string, revision: string, enabled: boolean }>())
  onScopeDispose(configuration.subscribe(() => revision.value++))
  watch(installed, (items) => {
    for (const [id, override] of overrides) {
      const plugin = items.find(item => item.manifest.id === override.extensionId)
      if (!plugin?.enabled || !plugin.compatible || plugin.generation !== override.generation || plugin.revision !== override.revision || ['failed', 'blocked'].includes(plugin.state))
        overrides.delete(id)
    }
  }, { flush: 'sync' })
  const entries = computed(() => {
    void revision.value
    return workbenchUiTargetCatalog.map((target) => {
      const previous = parseWorkbenchUiSelection(configuration.get(workbenchUiSelectionKey(target)), target.selection === 'multiple') ?? []
      const rank = (id: string) => previous.includes(id) ? previous.indexOf(id) : previous.length
      const providers = installed.value.filter(plugin => plugin.enabled && plugin.compatible)
        .flatMap(plugin => plugin.manifest.contributes.placements.flatMap(placement => (placement.kind === 'control' || placement.kind === 'slot') && placement.kind === target.kind && placement.target === target.target ? [{ plugin, placement, enabled: overrides.get(placement.id)?.enabled ?? placement.enabled ?? true }] : []))
        .sort((left, right) => rank(left.placement.id) - rank(right.placement.id) || left.placement.id.localeCompare(right.placement.id))
      return { ...target, providers }
    })
  })
  function providers(target: WorkbenchUiSelectionTarget) {
    return entries.value.find(entry => entry.kind === target.kind && entry.target === target.target)!.providers
  }
  function setEnabled(extensionId: string, generation: string, placementId: string, enabled: boolean) {
    const provider = entries.value.flatMap(entry => entry.providers).find(provider => provider.plugin.manifest.id === extensionId && provider.plugin.generation === generation && provider.placement.id === placementId && !['failed', 'blocked'].includes(provider.plugin.state))
    if (!provider)
      return null
    overrides.set(placementId, { extensionId, generation, revision: provider.plugin.revision, enabled })
    return { changed: provider.enabled !== enabled }
  }
  return { providers, setEnabled }
}

export type ExtensionUiContributions = ReturnType<typeof useExtensionUiContributions>
