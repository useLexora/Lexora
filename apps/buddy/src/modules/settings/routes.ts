import type { RouteRecordRaw } from 'vue-router'
import { DESKTOP_ROUTE_NAMES, desktopRouteLocations } from '@/shared/navigation/desktopRoutes'

export const settingsRoutes: ReadonlyArray<RouteRecordRaw> = [
  {
    path: '/settings',
    component: () => import('./pages/DesktopSettingsLayout.vue'),
    meta: { desktopView: 'settings' },
    redirect: desktopRouteLocations.settings(),
    children: [
      {
        path: 'mcp',
        name: DESKTOP_ROUTE_NAMES.settingsMcp,
        component: () => import('./pages/DesktopMcpSettingsView.vue'),
        meta: { desktopView: 'settings', settingsCategory: 'mcp' },
      },
      {
        path: 'skills',
        name: DESKTOP_ROUTE_NAMES.settingsSkills,
        component: () => import('./pages/DesktopSkillsSettingsView.vue'),
        meta: { desktopView: 'settings', settingsCategory: 'skills' },
      },
      {
        path: 'usage',
        name: DESKTOP_ROUTE_NAMES.settingsUsage,
        component: () => import('./pages/DesktopUsageSettingsView.vue'),
        meta: { desktopView: 'settings', settingsCategory: 'usage' },
      },
      {
        path: 'logs',
        name: DESKTOP_ROUTE_NAMES.settingsLogs,
        component: () => import('./pages/DesktopLogsSettingsView.vue'),
        meta: { desktopView: 'settings', settingsCategory: 'logs' },
      },
      {
        path: 'web',
        name: DESKTOP_ROUTE_NAMES.settingsWeb,
        component: () => import('./pages/DesktopWebSettingsView.vue'),
        meta: { desktopView: 'settings', settingsCategory: 'web' },
      },
      {
        path: 'app',
        name: DESKTOP_ROUTE_NAMES.settingsApp,
        redirect: desktopRouteLocations.settings('appearance'),
      },
      {
        path: 'appearance',
        name: DESKTOP_ROUTE_NAMES.settingsAppearance,
        component: () => import('./pages/DesktopAppearanceSettingsView.vue'),
        meta: { desktopView: 'settings', settingsCategory: 'appearance' },
      },
      {
        path: 'notifications',
        name: DESKTOP_ROUTE_NAMES.settingsNotifications,
        component: () => import('./pages/DesktopNotificationsSettingsView.vue'),
        meta: { desktopView: 'settings', settingsCategory: 'notifications' },
      },
      {
        path: 'proxy',
        name: DESKTOP_ROUTE_NAMES.settingsProxy,
        component: () => import('./pages/DesktopProxySettingsView.vue'),
        meta: { desktopView: 'settings', settingsCategory: 'proxy' },
      },
      {
        path: 'about',
        name: DESKTOP_ROUTE_NAMES.settingsAbout,
        component: () => import('./pages/DesktopAboutSettingsView.vue'),
        meta: { desktopView: 'settings', settingsCategory: 'about' },
      },
      {
        path: 'models',
        name: DESKTOP_ROUTE_NAMES.settingsModels,
        component: () => import('./pages/DesktopModelsSettingsView.vue'),
        meta: { desktopView: 'settings', settingsCategory: 'models' },
      },
      {
        path: 'models/:providerId',
        name: DESKTOP_ROUTE_NAMES.settingsProvider,
        component: () => import('./pages/DesktopProviderSettingsView.vue'),
        props: true,
        meta: { desktopView: 'settings', settingsCategory: 'models' },
      },
      {
        path: 'pet',
        name: DESKTOP_ROUTE_NAMES.settingsPet,
        component: () => import('./pages/DesktopPetSettingsView.vue'),
        meta: { desktopView: 'settings', settingsCategory: 'pet' },
      },
    ],
  },
]
