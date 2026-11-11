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

it('scopes broadcasts by extension and generation and header actions by exact view session', async () => {
  const installed = shallowRef<ExtensionStatus[]>(['tests.first', 'tests.second'].map(id => ({ manifest: extensionManifestSchema.parse({ schemaVersion: 1, id, name: id, version: '1.0.0', apiVersion: 3, engines: { lexora: '*' }, contributes: {} }), revision: 'first', enabled: true, compatible: true, development: false, pending: null, state: 'active', generation: crypto.randomUUID(), error: null, activationMs: null, logs: [] })))
  const api: Partial<ExtensionApi> = {
    openView: async input => ({ id: input.viewId, extensionId: input.extensionId, generation: installed.value.find(item => item.manifest.id === input.extensionId)!.generation!, token: crypto.randomUUID(), url: 'about:blank' }),
    closeView: async () => {},
  }
  const layoutCallbacks: (() => void)[] = []
  const layout: SurfaceLayout = { attach: (_element, options) => {
    layoutCallbacks.push(() => options.onLayout?.({ visible: true, width: 100, height: 100 }))
    return { update: () => {}, dispose: () => {} }
  }, invalidate: () => {} }
  const controller = new WorkbenchController(new ContributionRegistry())
  let views!: ExtensionViews
  const element = document.createElement('div')
  document.body.append(element)
  const app = createApp({
    setup() {
      views = useExtensionViews(api as ExtensionApi, installed, shallowRef({}))
      useProvideExtensionContext({ settingsLocation: () => null, state: { installed, api } as ExtensionContext['state'], views, ui: useExtensionUiContributions(installed, controller.configuration), anchors: new SemanticAnchorRegistry(), workbench: shallowRef({ values: {}, pages: [] }), language: shallowRef('en-US'), themeColors: shallowRef({}), isDark: shallowRef(false), endInteraction: () => {}, focusView: () => {}, authoring: { author: shallowRef(''), save: async () => true }, startCreation: async () => {} })
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
    const actions: unknown[] = []
    const target = frame.contentWindow!
    target.addEventListener('message', ({ data }) => {
      if (data?.channel === 'lexora-extension' && data.event?.type === 'view:message:received')
        messages.push(data)
      if (data?.channel === 'lexora-extension' && data.event?.type === 'view:settings-header-action:activated')
        actions.push(data)
    })
    return { target, messages, actions, session: views.surfaces.get(frame.dataset.extensionView!)!.session! }
  })
  const message = { action: 'increment', amount: 1 }
  const plugin = installed.value[0]!
  views.broadcast(plugin.manifest.id, crypto.randomUUID(), { action: 'obsolete' })
  views.broadcast(plugin.manifest.id, plugin.generation!, message)
  const flushMessages = () => Promise.all(frames.map(({ target }) => new Promise<void>((resolve) => {
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
  await flushMessages()
  expect(frames.map(frame => frame.messages)).toMatchObject([
    [{ channel: 'lexora-extension', token: frames[0]!.session.token, streamId: expect.any(String), sequence: expect.any(Number), event: { type: 'view:message:received', data: { message } } }],
    [{ channel: 'lexora-extension', token: frames[1]!.session.token, streamId: expect.any(String), sequence: expect.any(Number), event: { type: 'view:message:received', data: { message } } }],
    [],
  ])
  for (const callback of layoutCallbacks) callback()
  const session = frames[0]!.session
  const surface = views.surfaces.get(session.id)!
  surface.settingsHeaderActionsEnabled = true
  surface.ready = true
  expect(views.setSettingsHeaderActions(session.id, session.generation, session.token, [{ id: 'downloads', title: 'Downloads' }])).toBe(true)
  expect(views.activateSettingsHeaderAction(session.id, session.generation, session.token, 'downloads')).toBe(true)
  await flushMessages()
  expect(frames.map(frame => frame.actions)).toMatchObject([
    [{ token: session.token, event: { type: 'view:settings-header-action:activated', data: { id: 'downloads' } } }],
    [],
    [],
  ])
  surface.visible = false
  expect(views.activateSettingsHeaderAction(session.id, session.generation, session.token, 'downloads')).toBe(false)
  await flushMessages()
  expect(frames[0]!.actions).toHaveLength(1)
})

it('allows legacy deletion only from a focused visible ready frame and preserves accepted results after focus changes', async () => {
  const installed = shallowRef<ExtensionStatus[]>([{ manifest: extensionManifestSchema.parse({ schemaVersion: 1, id: 'tests.cleanup', name: 'Cleanup', version: '1.0.0', apiVersion: 4, engines: { lexora: '*' }, contributes: {} }), revision: 'first', enabled: true, compatible: true, development: false, pending: null, state: 'active', generation: crypto.randomUUID(), error: null, activationMs: null, logs: [] }])
  const viewRequest = vi.fn<ExtensionApi['viewRequest']>().mockResolvedValue({ status: 'deleted' })
  const api: Partial<ExtensionApi> = {
    openView: async input => ({ id: input.viewId, extensionId: input.extensionId, generation: installed.value[0]!.generation!, token: crypto.randomUUID(), url: 'about:blank' }),
    closeView: async () => {},
    viewRequest,
  }
  let layoutChanged = () => {}
  const layout: SurfaceLayout = { attach: (_element, options) => {
    layoutChanged = () => options.onLayout?.({ visible: true, width: 100, height: 100 })
    return { update: () => {}, dispose: () => {} }
  }, invalidate: () => {} }
  const controller = new WorkbenchController(new ContributionRegistry())
  let views!: ExtensionViews
  const root = document.createElement('div')
  document.body.append(root)
  const app = createApp({ setup() {
    views = useExtensionViews(api as ExtensionApi, installed, shallowRef({}))
    useProvideExtensionContext({ settingsLocation: () => null, state: { installed, api } as ExtensionContext['state'], views, ui: useExtensionUiContributions(installed, controller.configuration), anchors: new SemanticAnchorRegistry(), workbench: shallowRef({ values: {}, pages: [] }), language: shallowRef('en-US'), themeColors: shallowRef({}), isDark: shallowRef(false), endInteraction: () => {}, focusView: () => {}, authoring: { author: shallowRef(''), save: async () => true }, startCreation: async () => {} })
    return () => h(DesktopExtensionFrameHost, { layout })
  } })
  app.mount(root)
  disposables.push(() => {
    app.unmount()
    root.remove()
  })
  views.show({ extensionId: 'tests.cleanup', viewId: crypto.randomUUID(), viewType: 'tests.cleanup.page', resource: null, state: {}, stateVersion: 1 }, root, true)
  await vi.waitFor(() => expect(root.querySelector('iframe')).not.toBeNull())
  const frame = root.querySelector('iframe')!
  const surface = views.surfaces.get(frame.dataset.extensionView!)!
  const session = surface.session!
  const target = frame.contentWindow!
  const request = () => new Promise<{ ok: boolean, value: unknown }>((resolve) => {
    const id = crypto.randomUUID()
    const receive = ({ data }: MessageEvent) => {
      if (data.id === id) {
        target.removeEventListener('message', receive)
        resolve(data)
      }
    }
    target.addEventListener('message', receive)
    window.dispatchEvent(new MessageEvent('message', { source: target, data: { channel: 'lexora-extension', token: session.token, id, method: 'taskCleanup.delete', params: { conversationId: 'removed-task' } } }))
  })
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  layoutChanged()
  frame.focus()
  expect(await request()).toMatchObject({ ok: false, value: 'EXTENSION_TASK_CLEANUP_UNAVAILABLE' })
  surface.ready = true
  surface.visible = false
  expect(await request()).toMatchObject({ ok: false, value: 'EXTENSION_TASK_CLEANUP_UNAVAILABLE' })
  surface.visible = true
  document.body.tabIndex = -1
  document.body.focus()
  expect(await request()).toMatchObject({ ok: false, value: 'EXTENSION_TASK_CLEANUP_UNAVAILABLE' })
  expect(viewRequest).not.toHaveBeenCalled()
  frame.focus()
  viewRequest.mockImplementationOnce(async () => {
    document.body.focus()
    return { status: 'deleted' }
  })
  expect(await request()).toMatchObject({ ok: true, value: { status: 'deleted' } })
})
