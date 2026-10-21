// @vitest-environment jsdom
import type { ExtensionStatus } from '@buddy-shared/extensions/extensionApi'
import type { DesktopPageContribution } from '@/shared/navigation/desktopPages'
import { extensionManifestSchema } from '@buddy-shared/extensions/extensionManifest'
import { builtinSettingsCatalog } from '@buddy-shared/settings/settingsCatalog'
import { expect, it } from 'vitest'
import { shallowRef } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { settingsPage } from '@/modules/settings/routes'
import { desktopPageRoutes } from '@/shared/navigation/desktopPages'
import { desktopRouteLocations } from '@/shared/navigation/desktopRoutes'
import { createDesktopRouter } from '../index'
import { useDesktopPages } from '../useDesktopPages'

const page = (id: string, path: string): DesktopPageContribution => ({ id, title: () => id, order: 10, icon: { kind: 'named', name: 'navigationTask' }, location: path, routes: [{ path, component: { render: () => null } }] })

it('derives navigation and context from registered pages, including future modules', async () => {
  const settings = page('lexora.settings', '/settings')
  settings.routes = [{ path: '/settings', component: { render: () => null }, children: [{ path: ':category', component: { render: () => null }, meta: { settingsCategory: 'general' } }] }]
  settings.context = route => ({ 'page.section': route.meta.settingsCategory ?? '' })
  const router = createRouter({ history: createMemoryHistory(), routes: desktopPageRoutes([page('lexora.tasks', '/tasks'), settings, page('future.canvas', '/canvas')]) })
  await router.push('/settings/general?secret=private')
  const installed = shallowRef<ExtensionStatus[]>([])
  const pages = useDesktopPages(router, installed, shallowRef('en-US' as const))
  expect(pages.context.value.values).toEqual({ 'page.id': 'lexora.settings', 'page.section': 'general' })
  expect(pages.context.value.pages.map(page => page.id)).toContain('future.canvas')
  const previous = pages.context.value
  installed.value = []
  expect(pages.context.value).toBe(previous)
  await router.push('/canvas')
  expect(pages.context.value.values).toEqual({ 'page.id': 'future.canvas' })
  expect(pages.navigation.value.filter(entry => entry.active).map(entry => entry.id)).toEqual(['future.canvas'])
  expect(JSON.stringify(pages.context.value)).not.toContain('private')
  expect(() => desktopPageRoutes([settings, settings])).toThrow('already registered')
})

it('restores the last successful settings location without overriding explicit destinations', async () => {
  const settings: DesktopPageContribution = {
    ...settingsPage,
    routes: [{
      path: '/settings',
      component: { render: () => null },
      children: [
        { path: 'general', name: 'desktop.settings.general', component: { render: () => null } },
        { path: ':category', component: { render: () => null } },
        { path: 'models/:providerId', component: { render: () => null } },
        { path: 'plugins/:moduleId', component: { render: () => null } },
      ],
    }],
  }
  const router = createRouter({ history: createMemoryHistory(), routes: desktopPageRoutes([page('lexora.tasks', '/tasks'), settings]) })
  const pages = useDesktopPages(router, shallowRef<ExtensionStatus[]>([]), shallowRef('en-US' as const))
  const settingsLocation = () => pages.navigation.value.find(entry => entry.id === settings.id)!.location
  expect(router.resolve(settingsLocation()).fullPath).toBe('/settings/general')
  await router.push(settingsLocation())
  expect(router.currentRoute.value.fullPath).toBe('/settings/general')

  for (const location of ['/settings/appearance', '/settings/models/test.provider?group=details#credentials', '/settings/plugins/test.preferences?group=display']) {
    await router.push(location)
    await router.push('/tasks')
    await router.push(settingsLocation())
    expect(router.currentRoute.value.fullPath).toBe(location)
  }

  const removeGuard = router.beforeEach(to => to.path !== '/settings/notifications')
  await router.push('/settings/notifications')
  await router.push('/tasks')
  expect(settingsLocation()).toBe('/settings/plugins/test.preferences?group=display')
  removeGuard()

  await router.push(desktopRouteLocations.settings())
  expect(router.currentRoute.value.fullPath).toBe('/settings/general')
  await router.push('/tasks')
  await router.push(settingsLocation())
  expect(router.currentRoute.value.fullPath).toBe('/settings/general')
})

it('allows cold-start access only for trusted runtime-independent settings routes', () => {
  const router = createDesktopRouter(createMemoryHistory())
  for (const [category, capability] of Object.entries(builtinSettingsCatalog)) {
    const route = router.resolve(`/settings/${category}`)
    expect(route.meta.requiresRuntime, category).toBe(capability.requiresRuntime)
  }
  for (const location of [
    desktopRouteLocations.tasks(),
    desktopRouteLocations.buddies(),
    desktopRouteLocations.automations(),
    desktopRouteLocations.extensions(),
    desktopRouteLocations.extensionPage('test.navigation'),
    desktopRouteLocations.provider('test.provider'),
    '/settings/plugins/settings.storage',
  ]) {
    expect(router.resolve(location).meta.requiresRuntime).not.toBe(false)
  }
})

it('updates conditional plugin navigation without changing its page identity or installed state', async () => {
  const router = createRouter({ history: createMemoryHistory(), routes: desktopPageRoutes([page('lexora.tasks', '/tasks'), page('lexora.settings', '/settings')]) })
  const manifest = extensionManifestSchema.parse({ schemaVersion: 1, id: 'tests.page', name: 'Page', version: '1.0.0', apiVersion: 2, engines: { lexora: '*' }, contributes: { views: [{ id: 'tests.page.ui', title: 'Page', entry: 'ui.js', resource: 'none' }], navigation: { title: 'Page', view: 'tests.page.ui', when: { 'page.id': 'lexora.tasks' } } } })
  const installed = shallowRef<ExtensionStatus[]>([{ manifest, enabled: true, compatible: true, revision: 'r1', development: false, pending: null, generation: null, state: 'inactive', error: null, activationMs: null, logs: [] }])
  const pages = useDesktopPages(router, installed, shallowRef('en-US' as const))
  await router.push('/tasks')
  expect(pages.navigation.value.some(entry => entry.id === 'extension:tests.page')).toBe(true)
  await router.push('/settings')
  expect(pages.navigation.value.some(entry => entry.id === 'extension:tests.page')).toBe(false)
  expect(pages.context.value.pages.some(page => page.id === 'extension:tests.page')).toBe(true)
  installed.value = [{ ...installed.value[0]!, enabled: false }]
  expect(pages.context.value.pages.some(page => page.id === 'extension:tests.page')).toBe(false)
})
