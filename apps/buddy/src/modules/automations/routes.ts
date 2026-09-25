import type { RouteRecordRaw } from 'vue-router'
import type { DesktopPageContribution } from '@/shared/navigation/desktopPages'
import { translateBuddy } from '@/i18n/buddyI18n'
import { DESKTOP_ROUTE_NAMES, desktopRouteLocations } from '@/shared/navigation/desktopRoutes'

export const automationsRoutes: ReadonlyArray<RouteRecordRaw> = [
  {
    path: '/automations',
    name: DESKTOP_ROUTE_NAMES.automations,
    component: () => import('./pages/DesktopAutomationsLayout.vue'),
    children: [
      {
        path: '',
        component: () => import('./pages/DesktopAutomationIndexLayout.vue'),
        redirect: desktopRouteLocations.automations(),
        children: [
          {
            path: 'plans',
            name: DESKTOP_ROUTE_NAMES.automationsPlans,
            component: () => import('./pages/DesktopAutomationPlansView.vue'),
            meta: { automationSection: 'plans' },
          },
          {
            path: 'history',
            name: DESKTOP_ROUTE_NAMES.automationsHistory,
            component: () => import('./pages/DesktopAutomationHistoryView.vue'),
            meta: { automationSection: 'history' },
          },
        ],
      },
      {
        path: 'plans/new',
        name: DESKTOP_ROUTE_NAMES.automationsCreate,
        component: () => import('./pages/DesktopAutomationEditorView.vue'),
        props: { automationId: null },
        meta: { automationSection: 'plans' },
      },
      {
        path: 'plans/:automationId/edit',
        name: DESKTOP_ROUTE_NAMES.automationsEdit,
        component: () => import('./pages/DesktopAutomationEditorView.vue'),
        props: true,
        meta: { automationSection: 'plans' },
      },
    ],
  },
]

export const automationsPage: DesktopPageContribution = {
  id: 'lexora.automations',
  title: language => translateBuddy(language, 'desktop.navigation.automations'),
  icon: { kind: 'named', name: 'navigationAutomation' },
  order: 20,
  location: desktopRouteLocations.automations(),
  routes: automationsRoutes,
  context: route => ({ 'page.section': route.meta.automationSection ?? '' }),
}
