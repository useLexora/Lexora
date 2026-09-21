import type { RouteLocationRaw } from 'vue-router'

export type DesktopView = 'extension-page' | 'extensions' | 'automations' | 'settings' | 'tasks'
export type DesktopAutomationSection = 'history' | 'plans'
export type DesktopSettingsCategory = 'runtime' | 'shortcuts' | 'general' | 'appearance' | 'notifications' | 'pet' | 'models' | 'mcp' | 'skills' | 'extensions' | 'usage' | 'web' | 'browser' | 'proxy' | 'logs' | 'about'

export const DESKTOP_ROUTE_NAMES = {
  extensions: 'desktop.extensions',
  extensionPage: 'desktop.extension-page',
  automations: 'desktop.automations',
  automationsCreate: 'desktop.automations.create',
  automationsEdit: 'desktop.automations.edit',
  automationsHistory: 'desktop.automations.history',
  automationsPlans: 'desktop.automations.plans',
  settingsRuntime: 'desktop.settings.runtime',
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
  tasks: 'desktop.tasks',
} as const

const AUTOMATION_ROUTE_NAMES: Record<DesktopAutomationSection, string> = {
  history: DESKTOP_ROUTE_NAMES.automationsHistory,
  plans: DESKTOP_ROUTE_NAMES.automationsPlans,
}

const SETTINGS_ROUTE_NAMES: Record<DesktopSettingsCategory, string> = {
  runtime: DESKTOP_ROUTE_NAMES.settingsRuntime,
  shortcuts: DESKTOP_ROUTE_NAMES.settingsShortcuts,
  extensions: DESKTOP_ROUTE_NAMES.settingsExtensions,
  general: DESKTOP_ROUTE_NAMES.settingsGeneral,
  mcp: DESKTOP_ROUTE_NAMES.settingsMcp,
  appearance: DESKTOP_ROUTE_NAMES.settingsAppearance,
  notifications: DESKTOP_ROUTE_NAMES.settingsNotifications,
  proxy: DESKTOP_ROUTE_NAMES.settingsProxy,
  about: DESKTOP_ROUTE_NAMES.settingsAbout,
  skills: DESKTOP_ROUTE_NAMES.settingsSkills,
  logs: DESKTOP_ROUTE_NAMES.settingsLogs,
  usage: DESKTOP_ROUTE_NAMES.settingsUsage,
  web: DESKTOP_ROUTE_NAMES.settingsWeb,
  browser: DESKTOP_ROUTE_NAMES.settingsBrowser,
  models: DESKTOP_ROUTE_NAMES.settingsModels,
  pet: DESKTOP_ROUTE_NAMES.settingsPet,
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
  settings: (category: DesktopSettingsCategory = 'general'): RouteLocationRaw => ({
    name: SETTINGS_ROUTE_NAMES[category],
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
    desktopView?: DesktopView
    settingsCategory?: DesktopSettingsCategory
  }
}
