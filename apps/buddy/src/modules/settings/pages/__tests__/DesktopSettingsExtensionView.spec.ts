// @vitest-environment jsdom
import type { ExtensionApi, ExtensionStatus } from '@buddy-shared/extensions/extensionApi'
import type { SettingsContext } from '../../settingsContext'
import type { ExtensionViews } from '@/modules/extensions'
import { extensionManifestSchema } from '@buddy-shared/extensions/extensionManifest'
import { afterEach, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, shallowRef } from 'vue'
import { createMemoryHistory, createRouter, RouterView } from 'vue-router'
import { useExtensionViews, useProvideExtensionContext } from '@/modules/extensions'
import { useProvideSettingsContext } from '../../settingsContext'
import { useProvideSettingsModule } from '../../state/settingsModuleContext'
import DesktopSettingsExtensionView from '../DesktopSettingsExtensionView.vue'

const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).forEach(cleanup => cleanup()))

it('renders dynamic actions in the host header, dispatches to the same view and recreates cleanly after navigation', async () => {
  const manifest = extensionManifestSchema.parse({ schemaVersion: 1, id: 'tests.settings', name: 'Settings', version: '1.0.0', apiVersion: 3, engines: { lexora: '*' }, contributes: { views: [{ id: 'tests.settings.view', title: 'Models', entry: 'view.js', location: 'page', resource: 'none' }], settings: { modules: [{ id: 'tests.settings.module', title: '本地模型', view: 'tests.settings.view' }] } } })
  const generation = crypto.randomUUID()
  const installed = shallowRef<ExtensionStatus[]>([{ manifest, revision: 'first', enabled: true, compatible: true, development: false, pending: null, state: 'active', generation, error: null, activationMs: null, logs: [] }])
  const api: Partial<ExtensionApi> = {
    openView: async input => ({ id: input.viewId, extensionId: input.extensionId, generation, token: crypto.randomUUID(), url: 'about:blank' }),
    closeView: async () => {},
  }
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', redirect: '/models' }, { path: '/models', component: DesktopSettingsExtensionView }, { path: '/other', component: { render: () => h('h1', 'Other settings') } }] })
  let views!: ExtensionViews
  const clicked: { viewId: string, id: string }[] = []
  const root = document.createElement('div')
  document.body.append(root)
  const app = createApp({ setup() {
    views = useExtensionViews(api as ExtensionApi, installed, shallowRef({}))
    views.onBeforeClose(async () => true)
    views.onSettingsHeaderAction((session, id) => clicked.push({ viewId: session.id, id }))
    useProvideExtensionContext({ views, state: { installed, api }, language: shallowRef('zh-CN') } as unknown as Parameters<typeof useProvideExtensionContext>[0])
    useProvideSettingsContext({ applicationSettings: { language: shallowRef('zh-CN') } } as unknown as SettingsContext)
    useProvideSettingsModule(shallowRef({ id: 'tests.settings.module', owner: manifest.id, title: '本地模型', view: 'tests.settings.view', section: 'integrations', order: 0, requiresRuntime: false, groups: [] }))
    return () => h(RouterView)
  } })
  app.use(router)
  await router.push('/models')
  app.mount(root)
  cleanups.push(() => {
    app.unmount()
    root.remove()
  })
  await vi.waitFor(() => expect([...views.surfaces.values()][0]?.session).toBeTruthy())
  const surface = [...views.surfaces.values()][0]!
  const session = surface.session!
  expect(root.querySelector('header h1')?.textContent).toBe('本地模型')
  expect(root.querySelector('header button')).toBeNull()
  expect(views.setSettingsHeaderActions(session.id, generation, session.token, [{ id: 'engines', title: '推理引擎', icon: 'settings' }])).toBe(true)
  surface.ready = true
  await nextTick()
  expect(root.querySelector('header [data-extension-settings-header-actions]')?.textContent).toBe('推理引擎')
  expect(root.querySelector('[data-extension-surface] button')).toBeNull()
  root.querySelector<HTMLButtonElement>('header button')!.click()
  expect(clicked).toEqual([{ viewId: session.id, id: 'engines' }])
  expect(views.setSettingsHeaderActions(session.id, generation, session.token, [{ id: 'engines', title: '推理引擎' }, { id: 'downloads', title: '下载任务 3', icon: 'download' }])).toBe(true)
  await nextTick()
  expect([...root.querySelectorAll('header button')].map(button => button.textContent)).toEqual(['推理引擎', '下载任务 3'])
  root.querySelectorAll<HTMLButtonElement>('header button')[1]!.click()
  expect(clicked[1]).toEqual({ viewId: session.id, id: 'downloads' })
  for (const progress of [0, null, 42.8, 100, undefined]) {
    views.setSettingsHeaderActions(session.id, generation, session.token, [{ id: 'downloads', title: '下载历史 3', icon: 'download', progress }])
    await nextTick()
    const button = root.querySelector<HTMLButtonElement>('header button')!
    const indicator = button.querySelector('[role="progressbar"]')
    expect(button.textContent).toBe(`下载历史 3${typeof progress === 'number' ? `${Math.floor(progress)}%` : ''}`)
    expect(button.getAttribute('aria-label')).toBe(`下载历史 3${typeof progress === 'number' ? ` ${Math.floor(progress)}%` : ''}`)
    if (progress === undefined) {
      expect(indicator).toBeNull()
    }
    else {
      expect(indicator?.getAttribute('aria-label')).toBe('下载历史 3')
      expect(indicator?.getAttribute('aria-valuenow')).toBe(progress === null ? null : String(progress))
      expect(indicator?.getAttribute('aria-valuemin')).toBe('0')
      expect(indicator?.getAttribute('aria-valuemax')).toBe('100')
    }
  }
  await router.push('/other')
  await nextTick()
  expect(root.textContent).toBe('Other settings')
  expect(views.surfaces.size).toBe(0)
  expect(views.setSettingsHeaderActions(session.id, generation, session.token, [{ id: 'late', title: 'Late' }])).toBe(false)
  await router.push('/models')
  await vi.waitFor(() => expect([...views.surfaces.values()][0]?.session).toBeTruthy())
  const returned = [...views.surfaces.values()][0]!
  expect(returned.session!.id).not.toBe(session.id)
  expect(root.querySelector('header button')).toBeNull()
  returned.ready = true
  views.setSettingsHeaderActions(returned.session!.id, generation, returned.session!.token, [{ id: 'downloads', title: '下载任务 1' }])
  await nextTick()
  expect(root.querySelector('header button')?.textContent).toBe('下载任务 1')
  views.setSettingsHeaderActions(returned.session!.id, generation, returned.session!.token, [])
  await nextTick()
  expect(root.querySelector('[data-extension-settings-header-actions]')).toBeNull()
})
