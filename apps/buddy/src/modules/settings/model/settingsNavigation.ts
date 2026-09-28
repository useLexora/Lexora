import type { RouteLocationRaw } from 'vue-router'
import type { SettingsModule, SettingsModuleNode, SettingsSection, SettingsText } from './settingsRegistry'
import { translateBuddy } from '@/i18n/buddyMessages'
import { DESKTOP_ROUTE_NAMES, desktopRouteLocations } from '@/shared/navigation/desktopRoutes'

export const settingsNavigationSections: readonly { id: SettingsSection, title: SettingsText }[] = [
  { id: 'plugins', title: language => language === 'en-US' ? 'Plugins' : '插件' },
  ...(['personal', 'ai', 'integrations', 'system'] as const).map(id => ({ id, title: (language => translateBuddy(language, `desktop.settings.group.${id}`)) as SettingsText })),
]

export function settingsModuleLocation(module: SettingsModule) {
  return module.category ? desktopRouteLocations.settings(module.category) : { name: DESKTOP_ROUTE_NAMES.settingsPlugin, params: { moduleId: module.id } }
}

export function extensionSettingsLocation(modules: readonly SettingsModuleNode[], extensionId: string): RouteLocationRaw | null {
  const ownModule = modules.find(module => module.owner === extensionId)
  if (ownModule)
    return settingsModuleLocation(ownModule)
  for (const ownsGroup of [true, false]) {
    for (const module of modules) {
      const group = module.groups.find(group => ownsGroup ? group.owner === extensionId : group.items.some(item => item.kind === 'plugin' && item.field.extensionId === extensionId))
      if (group)
        return { ...settingsModuleLocation(module), query: { group: group.id } }
    }
  }
  return null
}
