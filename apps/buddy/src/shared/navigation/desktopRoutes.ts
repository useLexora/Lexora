import type { BuiltinSettingsCategory } from '@buddy-shared/settings/settingsCatalog'
import type { RouteLocationNormalizedLoaded, RouteLocationRaw } from 'vue-router'
import type { DesktopPageDefinition } from './desktopPages'

export type DesktopAutomationSection = 'history' | 'plans'
export type DesktopSettingsCategory = BuiltinSettingsCategory | 'extensions'

export const DESKTOP_ROUTE_NAMES = {
  extensions: 'desktop.extensions',
  extensionPage: 'desktop.extension-page',
  automations: 'desktop.automations',
  automationsCreate: 'desktop.automations.create',
  automationsEdit: 'desktop.automations.edit',
  automationsHistory: 'desktop.automations.history',
  automationsPlans: 'desktop.automations.plans',
  settingsRuntime: 'desktop.settings.runtime',
  settingsPrompts: 'desktop.settings.prompts',
  settingsMcp: 'desktop.settings.mcp',
  settingsExtensions: 'desktop.settings.extensions',
  settingsApp: 'desktop.settings.app',
  settingsGeneral: 'desktop.settings.general',
  settingsShortcuts: 'desktop.settings.shortcuts',
  settingsAppearance: 'desktop.settings.appearance',
  settingsNotifications: 'desktop.settings.notifications',
  settingsProxy: 'desktop.settings.proxy',
  settingsAbout: 'desktop.settings.about',
  settingsSkills: 'desktop.settings.skills',
  settingsLogs: 'desktop.settings.logs',
  settingsUsage: 'desktop.settings.usage',
  settingsWeb: 'desktop.settings.web',
  settingsBrowser: 'desktop.settings.browser',
  settingsModels: 'desktop.settings.models',
  settingsPet: 'desktop.settings.pet',
  settingsProvider: 'desktop.settings.models.provider',
  settingsPlugin: 'desktop.settings.plugin',
  tasks: 'desktop.tasks',
} as const

const AUTOMATION_ROUTE_NAMES: Record<DesktopAutomationSection, string> = {
  history: DESKTOP_ROUTE_NAMES.automationsHistory,
  plans: DESKTOP_ROUTE_NAMES.automationsPlans,
}

export const desktopRouteLocations = {
  extensions: (): RouteLocationRaw => ({ name: DESKTOP_ROUTE_NAMES.extensions }),
  extensionPage: (extensionId: string): RouteLocationRaw => ({ name: DESKTOP_ROUTE_NAMES.extensionPage, params: { extensionId } }),
  automationCreate: (): RouteLocationRaw => ({
    name: DESKTOP_ROUTE_NAMES.automationsCreate,
  }),
  automationEdit: (automationId: string): RouteLocationRaw => ({
    name: DESKTOP_ROUTE_NAMES.automationsEdit,
    params: { automationId },
  }),
  automations: (section: DesktopAutomationSection = 'plans'): RouteLocationRaw => ({
    name: AUTOMATION_ROUTE_NAMES[section],
  }),
  provider: (providerId: string): RouteLocationRaw => ({
    name: DESKTOP_ROUTE_NAMES.settingsProvider,
    params: { providerId },
  }),
  settings: (category: DesktopSettingsCategory = 'general') => ({
    name: `desktop.settings.${category}`,
  }),
  skills: (spaceId: string | null = null): RouteLocationRaw => ({
    name: DESKTOP_ROUTE_NAMES.settingsSkills,
    query: spaceId ? { space: spaceId } : {},
  }),
  tasks: (): RouteLocationRaw => ({ name: DESKTOP_ROUTE_NAMES.tasks }),
}

declare module 'vue-router' {
  interface RouteMeta {
    automationSection?: DesktopAutomationSection
    desktopPageDefinition?: DesktopPageDefinition
    desktopPage?: string | ((route: RouteLocationNormalizedLoaded) => string)
    settingsCategory?: DesktopSettingsCategory
    settingsModule?: string
  }
}
