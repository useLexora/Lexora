// @vitest-environment jsdom
import type { ExtensionApi, ExtensionStatus } from '@buddy-shared/extensions/extensionApi'
import type { ExtensionContext } from '../../extensionContext'
import type { ExtensionViews } from '../useExtensionViews'
import { extensionManifestSchema } from '@buddy-shared/extensions/extensionManifest'
import { afterEach, expect, it, vi } from 'vitest'
import { createApp, h, shallowRef } from 'vue'
import { createMemoryHistory, createRouter, RouterView } from 'vue-router'
import { useProvideExtensionContext } from '../../extensionContext'
import DesktopExtensionPageView from '../../pages/DesktopExtensionPageView.vue'
import { useExtensionViews } from '../useExtensionViews'

const cleanup: (() => void)[] = []
afterEach(() => cleanup.splice(0).forEach(dispose => dispose()))

it('preserves an Office page after a failed save on route leave or plugin replacement and leaves after saving', async () => {
  const installed = shallowRef<ExtensionStatus[]>(['tests.office', 'tests.other'].map(id => ({ manifest: extensionManifestSchema.parse({ schemaVersion: 1, id, name: id, version: '1.0.0', apiVersion: 4, engines: { lexora: '*' }, contributes: { navigation: { title: id, view: `${id}.page` }, views: [{ id: `${id}.page`, title: id, entry: 'view.js', resource: 'none' }] } }), revision: 'first', enabled: true, compatible: true, development: false, pending: null, state: 'active', generation: crypto.randomUUID(), error: null, activationMs: null, logs: [] })))
  const api: Partial<ExtensionApi> = {
    openView: async input => ({ id: input.viewId, extensionId: input.extensionId, generation: installed.value.find(item => item.manifest.id === input.extensionId)!.generation!, token: crypto.randomUUID(), url: 'about:blank' }),
    closeView: async () => {},
  }
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/office/:extensionId', component: DesktopExtensionPageView }, { path: '/elsewhere', component: { render: () => h('p', 'Elsewhere') } }] })
  let views!: ExtensionViews
  let saved = false
  const element = document.createElement('div')
  document.body.append(element)
  const app = createApp({ setup() {
    views = useExtensionViews(api as ExtensionApi, installed, shallowRef({}))
    views.onBeforeClose(async () => saved)
    useProvideExtensionContext({ state: { installed, api } as ExtensionContext['state'], views, language: shallowRef('en-US') } as ExtensionContext)
    return () => h(RouterView)
  } })
  app.use(router)
  await router.push('/office/tests.office')
  await router.isReady()
  app.mount(element)
  cleanup.push(() => {
    app.unmount()
    element.remove()
  })
  await vi.waitFor(() => expect([...views.surfaces.values()][0]?.session).toBeTruthy())
  const surface = [...views.surfaces.values()][0]!
  surface.ready = true
  await router.push('/elsewhere')
  expect(router.currentRoute.value.path).toBe('/office/tests.office')
  expect(views.surfaces.get(surface.input.viewId)).toBe(surface)
  await router.push('/office/tests.other')
  expect(router.currentRoute.value.path).toBe('/office/tests.office')
  expect(element.querySelector('[data-extension-page="tests.office"]')).not.toBeNull()
  saved = true
  await router.push('/office/tests.other')
  expect(router.currentRoute.value.path).toBe('/office/tests.other')
  expect(views.surfaces.has(surface.input.viewId)).toBe(false)
})
