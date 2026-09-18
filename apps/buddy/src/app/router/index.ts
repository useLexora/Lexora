import type {
  RouteRecordRaw,
  RouterHistory,
} from 'vue-router'
import {
  createRouter,
  createWebHashHistory,
} from 'vue-router'
import { automationsRoutes } from '@/modules/automations/routes'
import { extensionsRoutes } from '@/modules/extensions/routes'
import { settingsRoutes } from '@/modules/settings/routes'
import { tasksRoutes } from '@/modules/tasks/routes'
import { loadDesktopAppInfo, supportsSettingsCategory } from '@/platform/desktop/desktopCapabilities'
import { desktopRouteLocations } from '@/shared/navigation/desktopRoutes'

const routes: ReadonlyArray<RouteRecordRaw> = [
  {
    path: '/',
    redirect: desktopRouteLocations.tasks(),
  },
  ...extensionsRoutes,
  ...tasksRoutes,
  ...automationsRoutes,
  ...settingsRoutes,
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
