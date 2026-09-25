import type { RouteRecordRaw } from 'vue-router'
import type { DesktopPageContribution } from '@/shared/navigation/desktopPages'
import { translateBuddy } from '@/i18n/buddyI18n'
import { DESKTOP_ROUTE_NAMES, desktopRouteLocations } from '@/shared/navigation/desktopRoutes'

export const tasksRoutes: ReadonlyArray<RouteRecordRaw> = [
  {
    path: '/tasks',
    name: DESKTOP_ROUTE_NAMES.tasks,
    component: { render: () => null },
  },
]

export const tasksPage: DesktopPageContribution = {
  id: 'lexora.tasks',
  title: language => translateBuddy(language, 'desktop.navigation.tasks'),
  icon: { kind: 'named', name: 'navigationTask' },
  order: 10,
  location: desktopRouteLocations.tasks(),
  routes: tasksRoutes,
}
