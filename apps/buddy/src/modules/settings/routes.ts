import type { RouteRecordRaw } from 'vue-router'
import type { DesktopPageContribution } from '@/shared/navigation/desktopPages'
import { translateBuddy } from '@/i18n/buddyI18n'
import { DESKTOP_ROUTE_NAMES, desktopRouteLocations } from '@/shared/navigation/desktopRoutes'

export const settingsRoutes: ReadonlyArray<RouteRecordRaw> = [
  {
    path: '/settings',
    component: () => import('./pages/DesktopSettingsLayout.vue'),
    redirect: desktopRouteLocations.settings(),
    children: [
      {
        path: 'runtime',
        name: DESKTOP_ROUTE_NAMES.settingsRuntime,
        component: () => import('./pages/DesktopRuntimeSettingsView.vue'),
        meta: { settingsCategory: 'runtime' },
      },
      {
        path: 'shortcuts',
        name: DESKTOP_ROUTE_NAMES.settingsShortcuts,
        component: () => import('./pages/DesktopShortcutsSettingsView.vue'),
        meta: { settingsCategory: 'shortcuts' },
      },
      {
        path: 'extensions',
        name: DESKTOP_ROUTE_NAMES.settingsExtensions,
        redirect: desktopRouteLocations.extensions(),
      },
      {
        path: 'browser',
        name: DESKTOP_ROUTE_NAMES.settingsBrowser,
        component: () => import('./pages/DesktopBrowserSettingsView.vue'),
        meta: { settingsCategory: 'browser' },
      },
      {
        path: 'mcp',
        name: DESKTOP_ROUTE_NAMES.settingsMcp,
        component: () => import('./pages/DesktopMcpSettingsView.vue'),
        meta: { settingsCategory: 'mcp' },
      },
      {
        path: 'skills',
        name: DESKTOP_ROUTE_NAMES.settingsSkills,
        component: () => import('./pages/DesktopSkillsSettingsView.vue'),
        meta: { settingsCategory: 'skills' },
      },
      {
        path: 'usage',
        name: DESKTOP_ROUTE_NAMES.settingsUsage,
        component: () => import('./pages/DesktopUsageSettingsView.vue'),
        meta: { settingsCategory: 'usage' },
      },
      {
        path: 'logs',
        name: DESKTOP_ROUTE_NAMES.settingsLogs,
        component: () => import('./pages/DesktopLogsSettingsView.vue'),
        meta: { settingsCategory: 'logs' },
      },
      {
        path: 'web',
        name: DESKTOP_ROUTE_NAMES.settingsWeb,
        component: () => import('./pages/DesktopWebSettingsView.vue'),
        meta: { settingsCategory: 'web' },
      },
      {
        path: 'app',
        name: DESKTOP_ROUTE_NAMES.settingsApp,
        redirect: desktopRouteLocations.settings(),
      },
      {
        path: 'general',
        name: DESKTOP_ROUTE_NAMES.settingsGeneral,
        component: () => import('./pages/DesktopGeneralSettingsView.vue'),
        meta: { settingsCategory: 'general' },
      },
      {
        path: 'appearance',
        name: DESKTOP_ROUTE_NAMES.settingsAppearance,
        component: () => import('./pages/DesktopAppearanceSettingsView.vue'),
        meta: { settingsCategory: 'appearance' },
      },
      {
        path: 'notifications',
        name: DESKTOP_ROUTE_NAMES.settingsNotifications,
        component: () => import('./pages/DesktopNotificationsSettingsView.vue'),
        meta: { settingsCategory: 'notifications' },
      },
      {
        path: 'proxy',
        name: DESKTOP_ROUTE_NAMES.settingsProxy,
        component: () => import('./pages/DesktopProxySettingsView.vue'),
        meta: { settingsCategory: 'proxy' },
      },
      {
        path: 'about',
        name: DESKTOP_ROUTE_NAMES.settingsAbout,
        component: () => import('./pages/DesktopAboutSettingsView.vue'),
        meta: { settingsCategory: 'about' },
      },
      {
        path: 'models',
        name: DESKTOP_ROUTE_NAMES.settingsModels,
        component: () => import('./pages/DesktopModelsSettingsView.vue'),
        meta: { settingsCategory: 'models' },
      },
      {
        path: 'models/:providerId',
        name: DESKTOP_ROUTE_NAMES.settingsProvider,
        component: () => import('./pages/DesktopProviderSettingsView.vue'),
        props: true,
        meta: { settingsCategory: 'models' },
      },
      {
        path: 'pet',
        name: DESKTOP_ROUTE_NAMES.settingsPet,
        component: () => import('./pages/DesktopPetSettingsView.vue'),
        meta: { settingsCategory: 'pet' },
      },
    ],
  },
]

export const settingsPage: DesktopPageContribution = {
  id: 'lexora.settings',
  title: language => translateBuddy(language, 'desktop.navigation.settings'),
  icon: { kind: 'named', name: 'navigationSettings' },
  order: 50,
  location: desktopRouteLocations.settings(),
  routes: settingsRoutes,
  context: route => ({ 'page.section': route.meta.settingsCategory ?? '' }),
}
