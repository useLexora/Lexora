import type { RouteRecordRaw } from 'vue-router'
import { DESKTOP_ROUTE_NAMES } from '@/shared/navigation/desktopRoutes'

export const tasksRoutes: ReadonlyArray<RouteRecordRaw> = [
  {
    path: '/tasks',
    name: DESKTOP_ROUTE_NAMES.tasks,
    component: { render: () => null },
    meta: { desktopView: 'tasks' },
  },
]
