import type { ExtensionApi, ExtensionStatus, ExtensionViewInput } from '@buddy-shared/extensions/extensionApi'
// @vitest-environment jsdom
import type { WorkbenchContextValues } from '@buddy-shared/workbench/workbenchContext'
import type { ExtensionContext } from '../../extensionContext'
import type { ExtensionViews } from '../useExtensionViews'
import type { WorkbenchContext } from '@/workbench/browser/workbenchContext'
import { extensionManifestSchema } from '@buddy-shared/extensions/extensionManifest'
import { afterEach, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, provide, shallowRef } from 'vue'
import { SemanticAnchorRegistry } from '@/workbench/browser/surfaces/SemanticAnchorRegistry'
import { workbenchKey } from '@/workbench/browser/workbenchContext'
import { ContributionRegistry } from '@/workbench/services/ContributionRegistry'
import { WorkbenchController } from '@/workbench/services/WorkbenchController'
import { useProvideExtensionContext } from '../../extensionContext'
import { useExtensionUiContributions } from '../../state/useExtensionUiContributions'
import DesktopExtensionControl from '../DesktopExtensionControl.vue'
import { useExtensionViews } from '../useExtensionViews'

const disposables: (() => void)[] = []
afterEach(() => {
  disposables.splice(0).forEach(dispose => dispose())
  vi.restoreAllMocks()
})

async function setup() {
  const manifest = extensionManifestSchema.parse({
    schemaVersion: 1,
    id: 'tests.control',
    name: 'Control',
    version: '1.0.0',
    apiVersion: 2,
    engines: { lexora: '*' },
    permissions: { controls: ['model.reasoning'] },
    contributes: {
      views: [{ id: 'tests.control.slider', title: 'Slider', entry: 'slider.js', resource: 'none' }],
      placements: [{ id: 'tests.control.reasoning', kind: 'control', target: 'model.reasoning', view: 'tests.control.slider' }],
    },
  })
  const status: ExtensionStatus = { manifest, revision: 'package-1', enabled: true, compatible: true, development: false, pending: null, state: 'active', generation: crypto.randomUUID(), error: null, activationMs: null, logs: [] }
  const installed = shallowRef([status])
  const context = shallowRef<WorkbenchContextValues>({ 'page.id': 'lexora.tasks' })
  const controller = new WorkbenchController(new ContributionRegistry())
  controller.registry.register('configuration', scope => scope.configuration({ id: 'workbench.controls.model.reasoning', defaultValue: '', validate: value => typeof value === 'string' }))
  controller.configuration.set('workbench.controls.model.reasoning', 'tests.control.reasoning')
  const value = shallowRef('low')
  const mounted = shallowRef(true)
  const opened: ExtensionViewInput[] = []
  const api = {
    openView: async (input: ExtensionViewInput) => {
      opened.push(input)
      return { id: input.viewId, extensionId: input.extensionId, generation: installed.value.find(item => item.manifest.id === input.extensionId)!.generation!, token: crypto.randomUUID(), url: 'about:blank' }
    },
    closeView: async () => {},
    viewRequest: async () => null,
  } as unknown as ExtensionApi
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue(Object.assign([new DOMRect(0, 0, 240, 64)], { item: () => null }))
  let views!: ExtensionViews
  const element = document.createElement('div')
  document.body.append(element)
  const app = createApp({
    setup() {
      provide(workbenchKey, { controller } as WorkbenchContext)
      views = useExtensionViews(api, installed, context)
      useProvideExtensionContext({ settingsLocation: () => null, endInteraction: () => {}, views, workbench: shallowRef({ values: context.value, pages: [] }), state: { installed, api } as ExtensionContext['state'], anchors: new SemanticAnchorRegistry(), ui: useExtensionUiContributions(installed, controller.configuration), language: shallowRef('en-US'), themeColors: shallowRef({}), isDark: shallowRef(false), focusView: () => {}, authoring: { author: shallowRef(''), save: async () => true }, startCreation: async () => {} })
      return () => h('div', [
        mounted.value
          ? h(DesktopExtensionControl, {
              target: 'model.reasoning',
              contextKey: 'model-a',
              value: value.value,
              options: [{ value: 'low', label: 'Low' }, { value: 'high', label: 'High' }],
              disabled: false,
              onChange: next => value.value = next,
            }, { default: () => h('div', { 'data-native-control': '' }, value.value) })
          : null,
      ])
    },
  })
  app.mount(element)
  disposables.push(() => {
    app.unmount()
    element.remove()
  })
  const surface = () => [...views.surfaces.values()][0]!
  const ready = async () => {
    surface().ready = true
    await nextTick()
  }
  await nextTick()
  await nextTick()
  await ready()
  return { context, views, surface, ready, value, mounted, opened, installed, status, visibility, element }
}

it('rejects current proposals while the document is hidden even when the control has layout', async () => {
  const fixture = await setup()
  const surface = fixture.surface()
  const session = surface.session!
  const proposal = { revision: surface.control!.snapshot().revision, value: 'high' }
  fixture.visibility.mockReturnValue('hidden')
  expect(fixture.views.proposeControl(session.id, session.generation, session.token, proposal)).toBe(false)
  expect(fixture.value.value).toBe('low')
  fixture.visibility.mockReturnValue('visible')
  expect(fixture.views.proposeControl(session.id, session.generation, session.token, proposal)).toBe(true)
  expect(fixture.value.value).toBe('high')
})

it('falls back outside its page scope and invalidates proposals made before leaving', async () => {
  const f = await setup()
  f.status.manifest.contributes.placements[0]!.when = { 'page.id': 'lexora.tasks' }
  f.installed.value = [{ ...f.status }]
  const surface = f.surface()
  const session = surface.session!
  const old = { revision: surface.control!.snapshot().revision, value: 'high' }
  f.context.value = { 'page.id': 'lexora.settings' }
  await nextTick()
  expect(f.element.querySelector('[data-native-control]')).not.toBeNull()
  expect(f.views.proposeControl(session.id, session.generation, session.token, old)).toBe(false)
  f.context.value = { 'page.id': 'lexora.tasks' }
  await nextTick()
  expect(f.surface().session).toEqual(session)
  expect(f.element.querySelector('[data-native-control]')).toBeNull()
  expect(f.views.proposeControl(session.id, session.generation, session.token, old)).toBe(false)
  const current = { ...old, revision: surface.control!.snapshot().revision }
  expect(f.views.proposeControl(session.id, session.generation, session.token, current)).toBe(true)
  expect(f.value.value).toBe('high')
})

it('keeps the native fallback across popover remounts until explicitly retried', async () => {
  const fixture = await setup()
  fixture.views.fail(fixture.surface(), 'EXTENSION_VIEW_TIMEOUT')
  fixture.mounted.value = false
  await nextTick()
  expect(fixture.views.surfaces.size).toBe(0)
  fixture.installed.value = [{ ...fixture.status }]
  fixture.mounted.value = true
  await nextTick()
  await nextTick()
  expect(fixture.surface().error).toBe('EXTENSION_VIEW_TIMEOUT')
  expect(fixture.surface().session).toBeNull()
  expect(fixture.opened).toHaveLength(1)
  expect(fixture.element.querySelector('[data-native-control]')?.textContent).toBe('low')
  fixture.views.retryControl('tests.control.reasoning')
  await nextTick()
  await nextTick()
  await fixture.ready()
  expect(fixture.surface().session).not.toBeNull()
  expect(fixture.surface().error).toBe('')
  expect(fixture.element.querySelector('[data-native-control]')).toBeNull()
  expect(fixture.opened).toHaveLength(2)
})

it('recovers a failed control after the host restarts while the popover is closed', async () => {
  const fixture = await setup()
  fixture.views.fail(fixture.surface(), 'EXTENSION_VIEW_TIMEOUT')
  fixture.mounted.value = false
  await nextTick()
  fixture.installed.value = [{ ...fixture.status, state: 'inactive', generation: null }]
  fixture.installed.value = [{ ...fixture.status, generation: crypto.randomUUID() }]
  fixture.mounted.value = true
  await nextTick()
  await nextTick()
  await fixture.ready()
  expect(fixture.surface().session?.generation).toBe(fixture.installed.value[0]!.generation)
  expect(fixture.surface().error).toBe('')
  expect(fixture.element.querySelector('[data-native-control]')).toBeNull()
})

it('arbitrates competing controls and invalidates a proposal after a provider yields its surface', async () => {
  const f = await setup()
  const primary = f.surface()
  const primarySession = primary.session!
  const oldProposal = { revision: primary.control!.snapshot().revision, value: 'high' }
  const secondary: ExtensionStatus = {
    ...f.status,
    generation: crypto.randomUUID(),
    manifest: extensionManifestSchema.parse({
      ...f.status.manifest,
      id: 'tests.secondary',
      contributes: {
        views: [{ id: 'tests.secondary.slider', title: 'Other slider', entry: 'slider.js', resource: 'none' }],
        placements: [{ id: 'tests.secondary.control', view: 'tests.secondary.slider', kind: 'control', target: 'model.reasoning' }],
      },
    }),
  }
  f.installed.value = [secondary, f.status]
  await nextTick()
  await nextTick()
  const other = [...f.views.surfaces.values()].find(surface => surface.input.extensionId === secondary.manifest.id)!
  other.ready = true
  await nextTick()
  expect(primary.visible).toBe(true)
  expect(other.visible).toBe(false)
  const session = other.session!
  expect(f.views.proposeControl(session.id, session.generation, session.token, oldProposal)).toBe(false)
  expect(f.views.setActive(primarySession.id, primarySession.generation, primarySession.token, false)).toBe(true)
  await nextTick()
  expect(primary.visible).toBe(false)
  expect(other.visible).toBe(true)
  expect(f.element.querySelector('[data-native-control]')).toBeNull()
  expect(f.views.proposeControl(session.id, session.generation, session.token, oldProposal)).toBe(false)
  expect(f.views.setActive(primarySession.id, primarySession.generation, primarySession.token, true)).toBe(true)
  await nextTick()
  expect(f.views.proposeControl(primarySession.id, primarySession.generation, primarySession.token, oldProposal)).toBe(false)
  const current = { revision: primary.control!.snapshot().revision, value: 'high' }
  expect(f.views.proposeControl(primarySession.id, primarySession.generation, primarySession.token, current)).toBe(true)
  expect(f.value.value).toBe('high')
})
