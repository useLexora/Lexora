import type { RouteRecordRaw } from 'vue-router'
import { DESKTOP_ROUTE_NAMES } from '@/shared/navigation/desktopRoutes'

export const extensionsRoutes: RouteRecordRaw[] = [
  { path: '/extensions', name: DESKTOP_ROUTE_NAMES.extensions, component: () => import('./pages/DesktopExtensionsView.vue'), meta: { desktopView: 'extensions' } },
  { path: '/extensions/:extensionId/page', name: DESKTOP_ROUTE_NAMES.extensionPage, component: () => import('./pages/DesktopExtensionPageView.vue'), meta: { desktopView: 'extension-page' } },
]
