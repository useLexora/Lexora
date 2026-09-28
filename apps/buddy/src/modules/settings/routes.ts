import type { RouteRecordRaw } from 'vue-router'
import type { DesktopPageContribution } from '@/shared/navigation/desktopPages'
import { translateBuddy } from '@/i18n/buddyI18n'
import { DESKTOP_ROUTE_NAMES, desktopRouteLocations } from '@/shared/navigation/desktopRoutes'
import { builtinSettings } from './model/builtinSettings'

export const settingsRoutes: ReadonlyArray<RouteRecordRaw> = [
  {
    path: '/settings',
    component: () => import('./pages/DesktopSettingsLayout.vue'),
    redirect: desktopRouteLocations.settings(),
    children: [
      ...builtinSettings.modules.map(module => ({
        path: module.category,
        name: `desktop.settings.${module.category}`,
        component: () => import('./pages/DesktopSettingsModuleView.vue'),
        props: { moduleId: module.id },
        meta: { settingsCategory: module.category, settingsModule: module.id },
      })),
      {
        path: 'plugins/:moduleId',
        name: DESKTOP_ROUTE_NAMES.settingsPlugin,
        component: () => import('./pages/DesktopSettingsModuleView.vue'),
        props: true,
      },
      {
        path: 'models/:providerId',
        name: DESKTOP_ROUTE_NAMES.settingsProvider,
        component: () => import('./pages/DesktopProviderSettingsView.vue'),
        props: true,
        meta: { settingsCategory: 'models', settingsModule: 'settings.models' },
      },
      { path: 'extensions', name: DESKTOP_ROUTE_NAMES.settingsExtensions, redirect: desktopRouteLocations.extensions() },
      { path: 'app', name: DESKTOP_ROUTE_NAMES.settingsApp, redirect: desktopRouteLocations.settings() },
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
