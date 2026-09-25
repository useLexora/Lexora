import type {
  RouteRecordRaw,
  RouterHistory,
} from 'vue-router'
import {
  createRouter,
  createWebHashHistory,
} from 'vue-router'
import { loadDesktopAppInfo, supportsSettingsCategory } from '@/platform/desktop/desktopCapabilities'
import { desktopPageRoutes } from '@/shared/navigation/desktopPages'
import { desktopRouteLocations } from '@/shared/navigation/desktopRoutes'
import { desktopPages } from './desktopPages'

const routes: ReadonlyArray<RouteRecordRaw> = [
  {
    path: '/',
    redirect: desktopRouteLocations.tasks(),
  },
  ...desktopPageRoutes(desktopPages),
  {
    path: '/:pathMatch(.*)*',
    redirect: '/tasks',
  },
]

export function createDesktopRouter(history: RouterHistory = createWebHashHistory()) {
  const router = createRouter({ history, routes })
  router.beforeEach(async (to) => {
    const category = to.meta.settingsCategory
    if (!category || supportsSettingsCategory(null, category))
      return true
    const info = await loadDesktopAppInfo()
    return supportsSettingsCategory(info.capabilities, category) ? true : desktopRouteLocations.settings()
  })
  return router
}
