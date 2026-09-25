import type { WorkbenchCondition, WorkbenchContextValues } from '@buddy-shared/workbench/workbenchContext'
import type { Component } from 'vue'
import type { RouteLocationNormalizedLoaded, RouteLocationRaw, RouteRecordRaw } from 'vue-router'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import type { DesktopIconName } from '@/shared/ui/icon/desktopIcons'

export interface DesktopPageDefinition {
  id: string
  title: (language: BuddyLocale) => string
  location: RouteLocationRaw
  order: number
  icon: { kind: 'named', name: DesktopIconName } | { kind: 'component', component: Component } | { kind: 'plugin', url?: string }
  extensionId?: string
  when?: WorkbenchCondition
  context?: (route: RouteLocationNormalizedLoaded) => WorkbenchContextValues
}
export interface DesktopPageContribution extends DesktopPageDefinition {
  routes: readonly RouteRecordRaw[]
}
export interface DesktopNavigationEntry {
  id: string
  title: string
  location: RouteLocationRaw
  icon: DesktopPageDefinition['icon']
  extensionId?: string
  active: boolean
}
export function resolveDesktopPageId(route: RouteLocationNormalizedLoaded): string {
  const page = route.meta.desktopPage
  return typeof page === 'function' ? page(route) : page ?? ''
}
export function desktopPageRoutes(pages: readonly DesktopPageContribution[]): RouteRecordRaw[] {
  const ids = new Set<string>()
  return pages.flatMap((page) => {
    if (ids.has(page.id))
      throw new Error(`Desktop page already registered: ${page.id}`)
    ids.add(page.id)
    const { routes, ...definition } = page
    return routes.map(route => ({ ...route, meta: { desktopPage: page.id, desktopPageDefinition: definition, ...route.meta } }))
  })
}
