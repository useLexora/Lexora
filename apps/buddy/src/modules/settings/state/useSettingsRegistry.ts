import type { ExtensionStatus } from '@buddy-shared/extensions/extensionApi'
import type { Ref } from 'vue'
import { onScopeDispose, shallowRef, watch } from 'vue'
import { builtinSettings } from '../model/builtinSettings'
import { extensionSettingsLocation } from '../model/settingsNavigation'
import { SettingsRegistry } from '../model/settingsRegistry'

export function activeSettingsExtensions(installed: readonly ExtensionStatus[]): ExtensionStatus[] {
  return installed.filter(plugin => plugin.enabled && plugin.compatible && plugin.state !== 'blocked')
}

export function useSettingsRegistry(installed: Readonly<Ref<ExtensionStatus[]>>) {
  const registry = new SettingsRegistry()
  registry.register('settings', builtinSettings)
  const modules = shallowRef(registry.modules)
  const unsubscribe = registry.subscribe(() => modules.value = registry.modules)
  const registrations = new Map<string, { fingerprint: string, dispose: () => void }>()
  watch(installed, (plugins) => {
    const active = activeSettingsExtensions(plugins)
    for (const [id, registration] of registrations) {
      if (!active.some(plugin => plugin.manifest.id === id)) {
        registration.dispose()
        registrations.delete(id)
      }
    }
    for (const plugin of active) {
      const { id, contributes: { settings } } = plugin.manifest
      const fingerprint = JSON.stringify([plugin.revision, settings])
      if (registrations.get(id)?.fingerprint === fingerprint)
        continue
      const dispose = registry.register(id, {
        modules: settings.modules.map(module => ({ ...module, section: 'plugins', requiresRuntime: false })),
        groups: settings.groups,
        items: settings.items.map(item => ({ id: item.id, group: item.group, order: item.order, kind: 'plugin', field: { extensionId: id, revision: plugin.revision, item } })),
      })
      registrations.set(id, { fingerprint, dispose })
    }
  }, { immediate: true, flush: 'sync' })
  onScopeDispose(unsubscribe)
  return { modules, extensionLocation: (id: string) => extensionSettingsLocation(modules.value, id) }
}

export type SettingsRegistryState = ReturnType<typeof useSettingsRegistry>
