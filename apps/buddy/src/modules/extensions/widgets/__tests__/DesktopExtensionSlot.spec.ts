// @vitest-environment jsdom
import type { ExtensionApi, ExtensionStatus, ExtensionViewInput } from '@buddy-shared/extensions/extensionApi'
import type { WorkbenchContextValues } from '@buddy-shared/workbench/workbenchContext'
import type { ExtensionContext } from '../../extensionContext'
import type { ExtensionViews } from '../useExtensionViews'
import type { WorkbenchContext } from '@/workbench/browser/workbenchContext'
import { extensionManifestSchema } from '@buddy-shared/extensions/extensionManifest'
import { afterEach, expect, it } from 'vitest'
import { createApp, h, nextTick, provide, shallowRef } from 'vue'
import { SemanticAnchorRegistry } from '@/workbench/browser/surfaces/SemanticAnchorRegistry'
import { workbenchKey } from '@/workbench/browser/workbenchContext'
import { ContributionRegistry } from '@/workbench/services/ContributionRegistry'
import { WorkbenchController } from '@/workbench/services/WorkbenchController'
import { useProvideExtensionContext } from '../../extensionContext'
import { useExtensionUiContributions } from '../../state/useExtensionUiContributions'
import DesktopExtensionSlot from '../DesktopExtensionSlot.vue'
import DesktopExtensionUiSettings from '../DesktopExtensionUiSettings.vue'
import { useExtensionViews } from '../useExtensionViews'

const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).forEach(cleanup => cleanup()))

it('keeps the built-in footer until a selected slot view is ready and restores it when unavailable', async () => {
  const manifest = extensionManifestSchema.parse({
    schemaVersion: 1,
    id: 'tests.footer',
    name: 'Lyrics',
    version: '1.0.0',
    apiVersion: 3,
    engines: { lexora: '*' },
    contributes: {
      views: [{ id: 'tests.footer.lyrics', title: 'Lyrics', entry: 'lyrics.js', resource: 'none' }],
      placements: [{ id: 'tests.footer.placement', kind: 'slot', target: 'composer.footer', view: 'tests.footer.lyrics' }],
    },
  })
  const status: ExtensionStatus = { manifest, revision: 'package-1', enabled: true, compatible: true, development: false, pending: null, state: 'active', generation: crypto.randomUUID(), error: null, activationMs: null, logs: [] }
  const installed = shallowRef([status])
  const context = shallowRef<WorkbenchContextValues>({ 'page.id': 'lexora.tasks' })
  const controller = new WorkbenchController(new ContributionRegistry())
  controller.registry.register('configuration', scope => scope.configuration({ id: 'workbench.slots.composer.footer', defaultValue: '', validate: value => typeof value === 'string' }))
  const opened: ExtensionViewInput[] = []
  const api = {
    openView: async (input: ExtensionViewInput) => {
      opened.push(input)
      return { id: input.viewId, extensionId: input.extensionId, generation: status.generation!, token: crypto.randomUUID(), url: 'about:blank' }
    },
    closeView: async () => {},
  } as unknown as ExtensionApi
  let views!: ExtensionViews
  const element = document.createElement('div')
  document.body.append(element)
  const app = createApp({
    setup() {
      provide(workbenchKey, { controller } as WorkbenchContext)
      views = useExtensionViews(api, installed, context)
      useProvideExtensionContext({ endInteraction: () => {}, workbench: shallowRef({ values: context.value, pages: [] }), anchors: new SemanticAnchorRegistry(), ui: useExtensionUiContributions(installed, controller.configuration), state: { installed, api } as ExtensionContext['state'], views, language: shallowRef('en-US'), isDark: shallowRef(false), focusView: () => {}, startCreation: async () => {} })
      return () => h('div', [
        h(DesktopExtensionUiSettings, { language: 'en-US' }),
        ...[0, 1].map(index => h(DesktopExtensionSlot, { target: 'composer.footer' }, { default: () => h('p', `Verify results ${index}`) })),
      ])
    },
  })
  app.mount(element)
  cleanups.push(() => {
    app.unmount()
    element.remove()
  })

  expect(element.textContent).toContain('Verify results 0')
  expect(opened).toHaveLength(0)
  const select = element.querySelector('select')!
  select.value = 'tests.footer.placement'
  select.dispatchEvent(new Event('change', { bubbles: true }))
  await nextTick()
  await nextTick()
  expect(opened).toHaveLength(2)
  expect(new Set(opened.map(input => input.viewId)).size).toBe(2)
  expect(element.textContent).toContain('Verify results 0')

  for (const surface of views.surfaces.values()) surface.ready = true
  await nextTick()
  expect(element.textContent).not.toContain('Verify results')

  installed.value = [{ ...status, enabled: false, state: 'disabled' }]
  await nextTick()
  expect(element.textContent).toContain('Verify results 0')
  expect(element.textContent).toContain('Verify results 1')
  expect(controller.configuration.get('workbench.slots.composer.footer')).toBe('tests.footer.placement')
})
