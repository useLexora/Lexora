// @vitest-environment jsdom
import type { ExtensionApi, ExtensionStatus, ExtensionWorkbenchEvent } from '@buddy-shared/extensions/extensionApi'
import type { ExtensionViews } from '@/modules/extensions'
import type { WorkbenchPersistence } from '@/workbench/services/WorkbenchPersistence'
import { extensionManifestSchema } from '@buddy-shared/extensions/extensionManifest'
import { deferred } from '@buddy-tests/deferred'
import { afterEach, expect, it } from 'vitest'
import { effectScope, nextTick, shallowRef } from 'vue'
import { ViewRendererRegistry } from '@/workbench/browser/ViewRendererRegistry'
import { ContributionRegistry } from '@/workbench/services/ContributionRegistry'
import { WorkbenchController } from '@/workbench/services/WorkbenchController'
import { useExtensionContributions } from '../useExtensionContributions'

const scopes: ReturnType<typeof effectScope>[] = []
afterEach(() => scopes.splice(0).forEach(scope => scope.stop()))
function setup() {
  const status: ExtensionStatus = { manifest: extensionManifestSchema.parse({ schemaVersion: 1, id: 'tests.music', name: 'Music', version: '1.0.0', apiVersion: 2, engines: { lexora: '*' }, contributes: { views: [{ id: 'tests.music.player', title: 'Player', entry: 'player.js', resource: 'none' }], placements: [{ id: 'tests.music.dock', kind: 'view', view: 'tests.music.player', location: 'workbench.top' }] } }), revision: 'first', enabled: true, compatible: true, development: false, pending: null, state: 'active', generation: crypto.randomUUID(), error: null, activationMs: null, logs: [] }
  const installed = shallowRef([status])
  const ready = shallowRef(false)
  const controller = new WorkbenchController(new ContributionRegistry())
  controller.registry.register('configuration', scope => scope.configuration({ id: 'workbench.controls.model.reasoning', defaultValue: '', validate: value => typeof value === 'string' }))
  const replies = new Map<string, string | null>()
  let receive: (event: ExtensionWorkbenchEvent) => void = () => {}
  const api: Partial<ExtensionApi> = { onWorkbench: (listener) => {
    receive = listener
    return () => {}
  }, replyWorkbench: (id, view) => replies.set(id, view) }
  const views = { surfaces: new Map(), proposeControl: () => false } as unknown as ExtensionViews
  const persistence = { flush: async () => {} } as unknown as WorkbenchPersistence
  const scope = effectScope()
  scopes.push(scope)
  const contributions = scope.run(() => useExtensionContributions({ controller, renderers: new ViewRendererRegistry(), persistence, installed, api: api as ExtensionApi, views, ready: () => ready.value }))!
  const show = (): ExtensionWorkbenchEvent => ({ kind: 'placement', requestId: crypto.randomUUID(), extensionId: status.manifest.id, generation: status.generation!, placementId: 'tests.music.dock', visible: true })
  return { installed, ready, controller, status, contributions, views, replies, show, receive: (event: ExtensionWorkbenchEvent) => receive(event) }
}
async function settle() {
  for (let index = 0; index < 8; index++) await nextTick()
}

it('waits for core restore and the matching host snapshot before accepting startup placements', async () => {
  const fixture = setup()
  fixture.installed.value = [{ ...fixture.status, state: 'inactive', generation: null }]
  const event = fixture.show()
  fixture.receive(event)
  await settle()
  expect(fixture.controller.layout.views).toEqual({})
  fixture.ready.value = true
  await settle()
  expect(fixture.replies.size).toBe(0)
  fixture.installed.value = [fixture.status]
  await settle()
  expect(Object.values(fixture.controller.layout.views)).toHaveLength(1)
  expect(fixture.replies.get(event.requestId)).toBeTruthy()
})

it('cancels startup and controller-queued requests when their host or deadline expires', async () => {
  const fixture = setup()
  const startup = fixture.show()
  fixture.receive(startup)
  fixture.receive({ kind: 'cancel', requestId: startup.requestId })
  fixture.ready.value = true
  const guard = deferred<boolean>()
  const entered = deferred<void>()
  fixture.controller.registry.register('tasks', scope => scope.view({ id: 'task', renderer: 'task', label: 'Task', locations: ['main'], supports: () => true, multiple: false }))
  await fixture.controller.open({ scheme: 'task', id: 'one', data: {} }, 'One', { viewType: 'task' })
  Object.defineProperty(fixture.controller, 'beforeClose', { value: () => {
    entered.resolve()
    return guard.promise
  } })
  const replacing = fixture.controller.open({ scheme: 'task', id: 'two', data: {} }, 'Two', { viewType: 'task' })
  await entered.promise
  const event = fixture.show()
  fixture.receive(event)
  fixture.receive({ kind: 'cancel', requestId: event.requestId })
  guard.resolve(true)
  await replacing
  await settle()
  expect(Object.values(fixture.controller.layout.views).map(view => view.resource.scheme)).toEqual(['task'])
  expect(fixture.replies.size).toBe(0)
})

it('rebinds an updated placement without duplicating its view or replacing saved state', async () => {
  const fixture = setup()
  fixture.ready.value = true
  const event = fixture.show()
  fixture.receive(event)
  await settle()
  const id = fixture.replies.get(event.requestId)!
  fixture.controller.updateView(id, { state: { version: 1, value: { volume: 0.37 } } })
  const manifest = extensionManifestSchema.parse({ ...fixture.status.manifest, version: '2.0.0', contributes: { ...fixture.status.manifest.contributes, views: [{ id: 'tests.music.player2', title: 'Updated', entry: 'player.js', resource: 'none', stateVersion: 2 }], placements: [{ id: 'tests.music.dock', kind: 'view', view: 'tests.music.player2', location: 'workbench.bottom' }] } })
  fixture.installed.value = [{ ...fixture.status, manifest, revision: 'second' }]
  expect(fixture.controller.layout.views[id]).toMatchObject({ type: 'tests.music.player2', location: 'mount', placement: 'tests.music.dock', state: { version: 1, value: { volume: 0.37 } } })
  fixture.receive(fixture.show())
  await settle()
  expect(Object.keys(fixture.controller.layout.views)).toEqual([id])
  fixture.installed.value = []
  expect(fixture.controller.registry.placements.size).toBe(0)
  expect(fixture.controller.layout.views[id]?.state).toEqual({ version: 1, value: { volume: 0.37 } })
})

it('restores control selection without relying on unrelated layout changes', () => {
  const fixture = setup()
  fixture.controller.configuration.restore({ 'workbench.controls.model.reasoning': 'tests.reasoning.control' })
  expect(fixture.contributions.selection.value['model.reasoning']).toBe('tests.reasoning.control')
})

it('rejects an obsolete token when a view is reopened in the same host', async () => {
  const fixture = setup()
  fixture.ready.value = true
  const event = fixture.show()
  fixture.receive(event)
  await settle()
  const id = fixture.replies.get(event.requestId)!
  fixture.views.surfaces.set(id, { session: { generation: fixture.status.generation, token: crypto.randomUUID() } } as never)
  const state: ExtensionWorkbenchEvent = { kind: 'state', requestId: crypto.randomUUID(), viewId: id, generation: fixture.status.generation!, token: crypto.randomUUID(), stateVersion: 1, state: { volume: 1 } }
  fixture.receive(state)
  await settle()
  expect(fixture.replies.get(state.requestId)).toBeNull()
  expect(fixture.controller.layout.views[id]?.state.value).toEqual({})
})

it('persists presentation separately from plugin state and ignores expired sessions', async () => {
  const f = setup()
  f.ready.value = true
  const show = f.show()
  f.receive(show)
  await settle()
  const id = f.replies.get(show.requestId)!
  const token = crypto.randomUUID()
  f.views.surfaces.set(id, { session: { generation: f.status.generation, token } } as never)
  const event = { kind: 'presentation' as const, requestId: crypto.randomUUID(), viewId: id, generation: f.status.generation!, token, presentation: { height: 280 } }
  f.receive(event)
  await settle()
  expect(f.controller.layout.views[id]).toMatchObject({ state: { version: 1, value: {} }, presentation: { height: 280 } })
  expect(f.replies.get(event.requestId)).toBe(id)
  f.receive({ ...event, requestId: crypto.randomUUID(), token: crypto.randomUUID(), presentation: { height: 100 } })
  await settle()
  expect(f.controller.layout.views[id]?.presentation?.height).toBe(280)
})
