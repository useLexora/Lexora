import type { ExtensionDataSnapshot, ExtensionDataSource } from '@buddy-shared/extensions/extensionData'
import type { ExtensionContext } from '../extensionContext'
import type { ExtensionSurface } from '../widgets/useExtensionViews'
import { watch } from 'vue'
import { ExtensionDataClient } from './ExtensionDataClient'

export function extensionDataGrants(context: ExtensionContext, surface: ExtensionSurface): readonly ExtensionDataSource[] {
  const plugin = context.state.installed.value.find(plugin => plugin.manifest.id === surface.input.extensionId)
  return plugin?.enabled && plugin.compatible ? plugin.manifest.permissions.data : []
}

export function extensionDataSources(context: ExtensionContext, surface: ExtensionSurface): readonly ExtensionDataSource[] {
  const plugin = context.state.installed.value.find(plugin => plugin.manifest.id === surface.input.extensionId)
  return plugin?.enabled && plugin.compatible && plugin.generation === surface.session?.generation && !['failed', 'blocked'].includes(plugin.state) ? plugin.manifest.permissions.data : []
}
export function createExtensionDataClient(context: ExtensionContext, surface: ExtensionSurface, publish: (update: { id: string, snapshot: ExtensionDataSnapshot | null }) => void): ExtensionDataClient {
  return new ExtensionDataClient({
    sources: () => extensionDataSources(context, surface),
    binding: source => surface.eligible ? context.data?.binding(surface.input, source) ?? null : null,
    publish,
    observeChanges(listener) {
      const stopScope = context.data?.observeChanges(surface.input, listener)
      const stopPolicy = watch(() => [surface.eligible, surface.session?.token, extensionDataSources(context, surface).join(',')], listener, { flush: 'sync' })
      return () => {
        stopPolicy()
        stopScope?.()
      }
    },
  })
}
