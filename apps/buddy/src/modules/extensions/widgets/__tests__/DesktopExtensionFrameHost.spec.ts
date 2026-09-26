// @vitest-environment jsdom
import type { ExtensionApi, ExtensionStatus } from '@buddy-shared/extensions/extensionApi'
import type { ExtensionContext } from '../../extensionContext'
import type { ExtensionViews } from '../useExtensionViews'
import type { SurfaceLayout } from '@/shared/ui/surfaces/surfaceLayout'
import { extensionManifestSchema } from '@buddy-shared/extensions/extensionManifest'
import { afterEach, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, shallowRef } from 'vue'
import { SemanticAnchorRegistry } from '@/workbench/browser/surfaces/SemanticAnchorRegistry'
import { ContributionRegistry } from '@/workbench/services/ContributionRegistry'
import { WorkbenchController } from '@/workbench/services/WorkbenchController'
import { useProvideExtensionContext } from '../../extensionContext'
import { useExtensionUiContributions } from '../../state/useExtensionUiContributions'
import DesktopExtensionFrameHost from '../DesktopExtensionFrameHost.vue'
import { useExtensionViews } from '../useExtensionViews'

const disposables: (() => void)[] = []
afterEach(() => disposables.splice(0).forEach(dispose => dispose()))

it('delivers each broadcast once per frame only within the matching extension and generation', async () => {
  const installed = shallowRef<ExtensionStatus[]>(['tests.first', 'tests.second'].map(id => ({ manifest: extensionManifestSchema.parse({ schemaVersion: 1, id, name: id, version: '1.0.0', apiVersion: 3, engines: { lexora: '*' }, contributes: {} }), revision: 'first', enabled: true, compatible: true, development: false, pending: null, state: 'active', generation: crypto.randomUUID(), error: null, activationMs: null, logs: [] })))
  const api: Partial<ExtensionApi> = {
    openView: async input => ({ id: input.viewId, extensionId: input.extensionId, generation: installed.value.find(item => item.manifest.id === input.extensionId)!.generation!, token: crypto.randomUUID(), url: 'about:blank' }),
    closeView: async () => {},
  }
  const layout: SurfaceLayout = { attach: () => ({ update: () => {}, dispose: () => {} }), invalidate: () => {} }
  const controller = new WorkbenchController(new ContributionRegistry())
  let views!: ExtensionViews
  const element = document.createElement('div')
  document.body.append(element)
  const app = createApp({
    setup() {
      views = useExtensionViews(api as ExtensionApi, installed, shallowRef({}))
      useProvideExtensionContext({ state: { installed, api } as ExtensionContext['state'], views, ui: useExtensionUiContributions(installed, controller.configuration), anchors: new SemanticAnchorRegistry(), workbench: shallowRef({ values: {}, pages: [] }), language: shallowRef('en-US'), isDark: shallowRef(false), endInteraction: () => {}, focusView: () => {}, authoring: { author: shallowRef(''), save: async () => true }, startCreation: async () => {} })
      return () => h(DesktopExtensionFrameHost, { layout })
    },
  })
  app.mount(element)
  disposables.push(() => {
    app.unmount()
    element.remove()
  })
  for (const extensionId of ['tests.first', 'tests.first', 'tests.second']) {
    views.show({ extensionId, viewId: crypto.randomUUID(), viewType: `${extensionId}.view`, resource: null, state: {}, stateVersion: 1 }, element, true)
  }
  await nextTick()
  await vi.waitFor(() => expect(element.querySelectorAll('iframe')).toHaveLength(3))
  const frames = [...element.querySelectorAll('iframe')].map((frame) => {
    const messages: unknown[] = []
    const target = frame.contentWindow!
    target.addEventListener('message', ({ data }) => {
      if (data?.channel === 'lexora-extension' && 'message' in data)
        messages.push(data)
    })
    return { target, messages, session: views.surfaces.get(frame.dataset.extensionView!)!.session! }
  })
  const message = { action: 'increment', amount: 1 }
  const plugin = installed.value[0]!
  views.broadcast(plugin.manifest.id, crypto.randomUUID(), { action: 'obsolete' })
  views.broadcast(plugin.manifest.id, plugin.generation!, message)
  await Promise.all(frames.map(({ target }) => new Promise<void>((resolve) => {
    const marker = crypto.randomUUID()
    const receive = (event: MessageEvent) => {
      if (event.data === marker) {
        target.removeEventListener('message', receive)
        resolve()
      }
    }
    target.addEventListener('message', receive)
    target.postMessage(marker, '*')
  })))
  expect(frames.map(frame => frame.messages)).toEqual([
    [{ channel: 'lexora-extension', token: frames[0]!.session.token, message }],
    [{ channel: 'lexora-extension', token: frames[1]!.session.token, message }],
    [],
  ])
})
