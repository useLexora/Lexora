import type { ExtensionViewInput } from '@buddy-shared/extensions/extensionApi'
import type { WorkbenchUiSelectionTarget } from '@buddy-shared/workbench/workbenchUi'
import { workbenchUiTargetCatalog } from '@buddy-shared/workbench/workbenchUi'
import { computed, shallowRef, watch } from 'vue'
import { useWorkbenchUiScope } from '@/shared/ui/contributions/workbenchUiContext'
import { useExtensionContext } from '../extensionContext'

export function useExtensionUiSurfaces(target: () => WorkbenchUiSelectionTarget) {
  const { ui, views } = useExtensionContext()
  const scope = useWorkbenchUiScope()
  const providers = computed(() => ui.providers(target()))
  const inputs = shallowRef(new Map<string, ExtensionViewInput>())
  watch(() => providers.value.map(({ plugin, placement }) => `${placement.id}:${plugin.revision}:${scope?.instanceId() ?? ''}`), (keys) => {
    inputs.value = new Map(keys.map((key, index) => {
      const { plugin, placement } = providers.value[index]!
      return [key, inputs.value.get(key) ?? { viewId: crypto.randomUUID(), extensionId: plugin.manifest.id, viewType: placement.view, placementId: placement.id, instanceId: scope?.instanceId(), resource: null, state: null, stateVersion: 0 }]
    }))
  }, { immediate: true, flush: 'sync' })
  const surfaces = computed(() => [...inputs.value.values()].map((input) => {
    const entry = views.surfaces.get(input.viewId)
    const provider = providers.value.find(provider => provider.placement.id === input.placementId)!
    return { input, entry, height: provider.placement.height, available: provider.enabled && !!entry?.active && entry.ready && entry.eligible && !entry.error && !['failed', 'blocked'].includes(provider.plugin.state) }
  }))
  const selected = computed(() => {
    const current = target()
    const multiple = workbenchUiTargetCatalog.find(item => item.kind === current.kind && item.target === current.target)!.selection === 'multiple'
    return surfaces.value.filter(surface => surface.available).slice(0, multiple ? 8 : 1)
  })
  return { surfaces, selected }
}
