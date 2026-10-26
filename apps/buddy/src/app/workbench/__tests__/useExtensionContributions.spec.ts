// @vitest-environment jsdom
import type { ExtensionApi, ExtensionStatus, ExtensionWorkbenchEvent } from '@buddy-shared/extensions/extensionApi'
import type { ExtensionViews } from '@/modules/extensions'
import type { ViewCloseDecision } from '@/workbench/services/WorkbenchController'
import type { WorkbenchPersistence } from '@/workbench/services/WorkbenchPersistence'
import { extensionManifestSchema } from '@buddy-shared/extensions/extensionManifest'
import { deferred } from '@buddy-tests/deferred'
import { afterEach, expect, it, vi } from 'vitest'
import { effectScope, nextTick, shallowRef } from 'vue'
import { useExtensionUiContributions } from '@/modules/extensions'
import { ViewRendererRegistry } from '@/workbench/browser/ViewRendererRegistry'
import { ContributionRegistry } from '@/workbench/services/ContributionRegistry'
import { restoreWorkbenchLayout, WorkbenchController } from '@/workbench/services/WorkbenchController'
import { useExtensionContributions } from '../useExtensionContributions'

const scopes: ReturnType<typeof effectScope>[] = []
afterEach(() => scopes.splice(0).forEach(scope => scope.stop()))
function setup() {
  const status: ExtensionStatus = { manifest: extensionManifestSchema.parse({ schemaVersion: 1, id: 'tests.music', name: 'Music', version: '1.0.0', apiVersion: 2, engines: { lexora: '*' }, contributes: { views: [{ id: 'tests.music.player', title: 'Player', entry: 'player.js', resource: 'none' }], placements: [{ id: 'tests.music.dock', kind: 'view', view: 'tests.music.player', location: 'workbench.top' }] } }), revision: 'first', enabled: true, compatible: true, development: false, pending: null, state: 'active', generation: crypto.randomUUID(), error: null, activationMs: null, logs: [] }
  const installed = shallowRef([status])
  const ready = shallowRef(false)
  let beforeClose: () => Promise<ViewCloseDecision> = async () => true
  const controller = new WorkbenchController(new ContributionRegistry(), () => beforeClose())
  controller.registry.register('configuration', scope => scope.configuration({ id: 'workbench.controls.model.reasoning', defaultValue: '', validate: value => typeof value === 'string' }))
  const replies = new Map<string, string | null>()
  let receive: (event: ExtensionWorkbenchEvent) => void = () => {}
  const api: Partial<ExtensionApi> = { endInteraction: async () => {}, onWorkbench: (listener) => {
    receive = listener
    return () => {}
  }, replyWorkbench: (id, view) => {
    if (typeof view === 'string' || view === null)
      replies.set(id, view)
  } }
  const views = { surfaces: new Map(), proposeControl: () => false, retryControl: () => {} } as unknown as ExtensionViews
  const checkpoints: { views: typeof controller.layout.views, configuration: ReturnType<typeof controller.configuration.snapshot> }[] = []
  const persistence = { flush: async () => {}, checkpoint: async () => {
    checkpoints.push(structuredClone({ views: controller.layout.views, configuration: controller.configuration.snapshot() }))
  } } as unknown as WorkbenchPersistence
  const scope = effectScope()
  scopes.push(scope)
  const contributions = scope.run(() => useExtensionUiContributions(installed, controller.configuration))!
  scope.run(() => useExtensionContributions({ controller, renderers: new ViewRendererRegistry(), persistence, installed, api: api as ExtensionApi, views, ui: contributions, ready: () => ready.value }))!
  const show = (): Extract<ExtensionWorkbenchEvent, { kind: 'placement' }> => ({ kind: 'placement', requestId: crypto.randomUUID(), extensionId: status.manifest.id, generation: status.generation!, placementId: 'tests.music.dock', visible: true })
  return { setBeforeClose: (value: () => Promise<ViewCloseDecision>) => {
    beforeClose = value
  }, installed, ready, controller, status, api, contributions, views, replies, show, checkpoints, receive: (event: ExtensionWorkbenchEvent) => receive(event) }
}
function withLauncher(f: ReturnType<typeof setup>, resource: 'none' | 'optional-file' = 'none') {
  f.installed.value = [{ ...f.status, revision: 'launcher', manifest: extensionManifestSchema.parse({
    ...f.status.manifest,
    apiVersion: 4,
    permissions: { ...f.status.manifest.permissions, selectedResource: resource === 'optional-file' ? 'read' : 'none' },
    contributes: {
      ...f.status.manifest.contributes,
      views: [{ ...f.status.manifest.contributes.views[0]!, resource }],
      placements: [],
      launchers: [{ id: 'tests.music.launch', title: 'Launch player', view: 'tests.music.player' }],
    },
  }) }]
}

it('opens an optional-file launcher only through host preparation without introducing a file or task scope', async () => {
  const f = setup()
  const requests: unknown[] = []
  f.api.prepareFileOpening = async (input) => {
    requests.push(input)
    return { extensionId: 'tests.music', viewType: 'tests.music.player', resource: null }
  }
  withLauncher(f, 'optional-file')
  f.ready.value = true
  const root = f.controller.layout.root
  const launcher = f.controller.registry.launchers.get('tests.music.launch')!
  await f.controller.commands.execute(launcher.command)
  const [view] = Object.values(f.controller.layout.views)
  expect(view).toMatchObject({ type: 'tests.music.player', title: 'Launch player', location: 'context', resource: { scheme: 'extension', data: { extensionId: 'tests.music', viewType: 'tests.music.player', resource: null } }, state: { version: 1, value: {} } })
  expect(f.controller.layout.root).toBe(root)
  expect(requests).toEqual([{ providerId: 'tests.music.launch', location: 'standalone', source: null }])
  f.installed.value = [{ ...f.installed.value[0]!, enabled: false }]
  expect(f.controller.registry.launchers.size).toBe(0)
  expect(f.controller.layout.views[view!.id]).toBe(view)
})

it.each(['disable', 'update', 'remove'] as const)('does not open a launcher prepared after owner %s and preserves replacement registrations', async (operation) => {
  const f = setup()
  const prepared = deferred<{ extensionId: string, viewType: string, resource: null }>()
  f.api.prepareFileOpening = () => prepared.promise
  withLauncher(f)
  f.ready.value = true
  const opening = f.controller.commands.execute(f.controller.registry.launchers.get('tests.music.launch')!.command)
  const status = f.installed.value[0]!
  f.installed.value = operation === 'remove' ? [] : [{ ...status, enabled: operation !== 'disable', revision: operation === 'update' ? 'updated' : status.revision }]
  prepared.resolve({ extensionId: 'tests.music', viewType: 'tests.music.player', resource: null })
  await opening
  expect(f.controller.layout.views).toEqual({})
  expect(f.controller.registry.launchers.has('tests.music.launch')).toBe(operation === 'update')
})

it('treats a preparation rejected after owner withdrawal as cancellation', async () => {
  const f = setup()
  const prepared = deferred<never>()
  f.api.prepareFileOpening = () => prepared.promise
  withLauncher(f)
  f.ready.value = true
  const opening = f.controller.commands.execute(f.controller.registry.launchers.get('tests.music.launch')!.command)
  f.installed.value = []
  prepared.reject(new Error('EXTENSION_UNAVAILABLE'))
  await expect(opening).resolves.toMatchObject({ status: 'completed' })
  expect(f.controller.layout.views).toEqual({})
})

it('rechecks view context after launcher preparation without introducing an obsolete view', async () => {
  const f = setup()
  const prepared = deferred<{ extensionId: string, viewType: string, resource: null }>()
  f.api.prepareFileOpening = () => prepared.promise
  withLauncher(f)
  const status = f.installed.value[0]!
  f.installed.value = [{ ...status, revision: 'conditional', manifest: extensionManifestSchema.parse({
    ...status.manifest,
    contributes: { ...status.manifest.contributes, views: status.manifest.contributes.views.map(view => ({ ...view, when: { 'page.id': 'tasks' } })) },
  }) }]
  f.ready.value = true
  const page = f.controller.contextKeys.bind({ 'page.id': 'tasks' })
  const launcher = f.controller.registry.launchers.get('tests.music.launch')!
  expect(launcher.when?.(f.controller.contextKeys.snapshot())).toBe(true)
  const opening = f.controller.commands.execute(launcher.command)
  page.update({ 'page.id': 'settings' })
  expect(launcher.when?.(f.controller.contextKeys.snapshot())).toBe(false)
  prepared.resolve({ extensionId: 'tests.music', viewType: 'tests.music.player', resource: null })
  await opening
  expect(f.controller.layout.views).toEqual({})
})

it('does not fabricate a view or resource when launcher preparation fails', async () => {
  const f = setup()
  f.api.prepareFileOpening = async () => {
    throw new Error('EXTENSION_VIEW_UNAVAILABLE')
  }
  withLauncher(f)
  f.ready.value = true
  await expect(f.controller.commands.execute(f.controller.registry.launchers.get('tests.music.launch')!.command)).rejects.toThrow('EXTENSION_VIEW_UNAVAILABLE')
  expect(f.controller.layout.views).toEqual({})
})

async function settle() {
  for (let index = 0; index < 8; index++) await nextTick()
}

it('clears only the requested plugin views and legacy selections before acknowledging persisted cleanup', async () => {
  const f = setup()
  f.ready.value = true
  f.controller.registry.register('tasks', scope => scope.view({ id: 'task', renderer: 'task', label: 'Task', locations: ['main'], supports: () => true, multiple: false }))
  const task = await f.controller.open({ scheme: 'task', id: 'retained', data: {} }, 'Task', { viewType: 'task' })
  const show = f.show()
  f.receive(show)
  await settle()
  const id = f.replies.get(show.requestId)!
  const original = f.controller.layout.views[id]!
  const other = { ...original, id: crypto.randomUUID(), resource: { ...original.resource, data: { ...original.resource.data, extensionId: 'tests.other' } } }
  f.controller.restoreLayout({ ...f.controller.layout, views: { ...f.controller.layout.views, [other.id]: other } })
  f.controller.configuration.restore({ 'workbench.controls.model.reasoning': 'tests.music.retired', 'workbench.slots.composer.accessory': JSON.stringify(['tests.music.dock', 'tests.music.retired', 'tests.music-other.dock', 'tests.other.dock']), 'host-setting': true })
  f.installed.value = []
  const event = { kind: 'clear-data' as const, requestId: crypto.randomUUID(), extensionId: 'tests.music' }
  f.receive(event)
  await vi.waitFor(() => expect(f.replies.get(event.requestId)).toBe(event.requestId))
  expect(Object.keys(f.controller.layout.views).sort()).toEqual([task!, other.id].sort())
  expect(f.checkpoints).toEqual([{ views: f.controller.layout.views, configuration: { 'workbench.slots.composer.accessory': JSON.stringify(['tests.music-other.dock', 'tests.other.dock']), 'host-setting': true } }])
})

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
  fixture.setBeforeClose(() => {
    entered.resolve()
    return guard.promise
  })
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

it.each(['running', 'restoring'])('migrates a global placement into the active pane with its saved identity and state when %s', async (mode) => {
  const f = setup()
  f.ready.value = true
  f.controller.registry.register('tasks', scope => scope.view({ id: 'task', renderer: 'task', label: 'Task', locations: ['main'], supports: () => true, multiple: false }))
  await f.controller.open({ scheme: 'task', id: 'one', data: {} }, 'One', { viewType: 'task' })
  const first = f.controller.layout.activePane
  await f.controller.open({ scheme: 'task', id: 'two', data: {} }, 'Two', { viewType: 'task', direction: 'right' })
  const second = f.controller.layout.activePane
  const original = f.show()
  f.receive(original)
  await settle()
  const id = f.replies.get(original.requestId)!
  const state = { version: 1, value: { volume: 0.37 } }
  f.controller.updateView(id, { state })
  if (mode === 'restoring') {
    f.ready.value = false
    f.controller.restoreLayout(restoreWorkbenchLayout(JSON.parse(JSON.stringify(f.controller.layout))))
  }
  const manifest = extensionManifestSchema.parse({ ...f.status.manifest, apiVersion: 3, version: '2.0.0', contributes: { ...f.status.manifest.contributes, views: f.status.manifest.contributes.views.map(view => ({ ...view, stateVersion: 2 })), placements: [{ id: 'tests.music.dock', kind: 'view', view: 'tests.music.player', target: 'workbench.pane' }] } })
  f.installed.value = [{ ...f.status, manifest, revision: 'pane-package' }]
  const reopened = f.show()
  f.receive(reopened)
  f.ready.value = true
  await settle()
  expect(f.replies.get(reopened.requestId)).toBe(id)
  expect(Object.values(f.controller.layout.views).filter(view => view.resource.scheme === 'extension')).toHaveLength(1)
  expect(f.controller.layout.views[id]).toMatchObject({ id, mountInstanceId: second, state })
  f.controller.activate(first)
  f.installed.value = [...f.installed.value]
  expect(f.controller.layout.views[id]?.mountInstanceId).toBe(second)
  const otherPane = { ...f.show(), kind: 'placement' as const, instanceId: first }
  f.receive(otherPane)
  await settle()
  const otherId = f.replies.get(otherPane.requestId)!
  expect(otherId).not.toBe(id)
  expect(f.controller.layout.views[otherId]).toMatchObject({ mountInstanceId: first, state: { version: 2, value: {} } })
  expect(restoreWorkbenchLayout(JSON.parse(JSON.stringify(f.controller.layout))).views[id]).toMatchObject({ id, mountInstanceId: second, state })
})

it('migrates a pane placement to global scope without retaining the old pane lifecycle', async () => {
  const f = setup()
  f.ready.value = true
  f.installed.value = [{ ...f.status, revision: 'pane-package', manifest: extensionManifestSchema.parse({ ...f.status.manifest, apiVersion: 3, contributes: { ...f.status.manifest.contributes, placements: [{ id: 'tests.music.dock', kind: 'view', view: 'tests.music.player', target: 'workbench.pane' }] } }) }]
  f.controller.registry.register('tasks', scope => scope.view({ id: 'task', renderer: 'task', label: 'Task', locations: ['main'], supports: () => true, multiple: false }))
  await f.controller.open({ scheme: 'task', id: 'one', data: {} }, 'One', { viewType: 'task' })
  const task = (await f.controller.open({ scheme: 'task', id: 'two', data: {} }, 'Two', { viewType: 'task', direction: 'right' }))!
  const pane = f.controller.layout.activePane
  const original = f.show()
  f.receive(original)
  await settle()
  const id = f.replies.get(original.requestId)!
  const state = { version: 1, value: { volume: 0.37 } }
  f.controller.updateView(id, { state })
  expect(f.controller.layout.views[id]?.mountInstanceId).toBe(pane)
  f.installed.value = [f.status]
  const reopened = f.show()
  f.receive(reopened)
  await settle()
  expect(f.replies.get(reopened.requestId)).toBe(id)
  expect(f.controller.layout.views[id]?.mountInstanceId).toBeUndefined()
  await f.controller.close(task)
  expect(f.controller.pane(pane)).toBeNull()
  expect(Object.values(f.controller.layout.views).filter(view => view.resource.scheme === 'extension')).toHaveLength(1)
  expect(restoreWorkbenchLayout(JSON.parse(JSON.stringify(f.controller.layout))).views[id]).toMatchObject({ id, state })
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
  const expired = [
    { ...event, requestId: crypto.randomUUID(), token: crypto.randomUUID(), presentation: { height: 100 } },
    { kind: 'state' as const, requestId: crypto.randomUUID(), viewId: id, generation: f.status.generation!, token: crypto.randomUUID(), stateVersion: 1, state: { volume: 1 } },
  ]
  for (const request of expired) f.receive(request)
  await settle()
  for (const request of expired) expect(f.replies.get(request.requestId)).toBeNull()
  expect(f.controller.layout.views[id]).toMatchObject({ state: { version: 1, value: {} }, presentation: { height: 280 } })
})

it('keeps pane placements independent across focus, close and restore', async () => {
  const f = setup()
  f.ready.value = true
  f.installed.value = [{ ...f.status, revision: 'pane-package', manifest: extensionManifestSchema.parse({ ...f.status.manifest, apiVersion: 3, contributes: { ...f.status.manifest.contributes, placements: [{ id: 'tests.music.dock', kind: 'view', view: 'tests.music.player', target: 'workbench.pane' }] } }) }]
  f.controller.registry.register('tasks', scope => scope.view({ id: 'task', renderer: 'task', label: 'Task', locations: ['main'], supports: () => true, multiple: false }))
  await f.controller.open({ scheme: 'task', id: 'one', data: {} }, 'One', { viewType: 'task' })
  const first = f.controller.layout.activePane
  const secondTask = (await f.controller.open({ scheme: 'task', id: 'two', data: {} }, 'Two', { viewType: 'task', direction: 'right' }))!
  const second = f.controller.layout.activePane
  const show = (instanceId: string) => ({ ...f.show(), kind: 'placement' as const, placementId: 'tests.music.dock', extensionId: f.status.manifest.id, generation: f.status.generation!, visible: true, instanceId })
  const left = show(first)
  const right = show(second)
  f.receive(left)
  f.receive(right)
  f.controller.activate(first)
  await settle()
  await vi.waitFor(() => expect(f.replies.has(right.requestId)).toBe(true))
  const leftId = f.replies.get(left.requestId)!
  const rightId = f.replies.get(right.requestId)!
  expect(leftId).not.toBe(rightId)
  expect(f.controller.layout.views[leftId]?.mountInstanceId).toBe(first)
  expect(f.controller.layout.views[rightId]?.mountInstanceId).toBe(second)
  f.controller.updateView(leftId, { state: { version: 1, value: { count: 7 } } })
  f.controller.updateView(rightId, { state: { version: 1, value: { count: 3 } } })
  const saved = JSON.parse(JSON.stringify(f.controller.layout))
  expect(restoreWorkbenchLayout(saved).views[leftId]?.state.value).toEqual({ count: 7 })
  f.receive({ ...left, requestId: crypto.randomUUID(), visible: false })
  await settle()
  expect(f.controller.layout.views[leftId]).toBeUndefined()
  expect(f.controller.layout.views[rightId]?.state.value).toEqual({ count: 3 })
  await f.controller.close(secondTask)
  expect(f.controller.layout.views[rightId]).toBeUndefined()
  const obsolete = show(second)
  f.receive(obsolete)
  await settle()
  expect(f.replies.get(obsolete.requestId)).toBeNull()
  saved.root = { kind: 'pane', id: first, view: null }
  const restored = restoreWorkbenchLayout(saved)
  expect(restored.root).toEqual(saved.root)
  expect(restored.views[leftId]?.state.value).toEqual({ count: 7 })
  expect(restored.views[rightId]).toBeUndefined()
})

it('withdraws transient surfaces immediately and never restores an ended interaction', async () => {
  const f = setup()
  f.ready.value = true
  f.installed.value = [{ ...f.status, revision: 'next', manifest: extensionManifestSchema.parse({ ...f.status.manifest, apiVersion: 3, contributes: { ...f.status.manifest.contributes, placements: [{ id: 'tests.music.dock', kind: 'view', view: 'tests.music.player', target: 'workbench', interaction: 'regions', presentation: { position: 'absolute' } }] } }) }]
  const interactionId = crypto.randomUUID()
  f.receive({ kind: 'interaction', requestId: crypto.randomUUID(), extensionId: f.status.manifest.id, generation: f.status.generation!, interactionId, title: 'Music' })
  await settle()
  const show = { ...f.show(), interactionId }
  f.receive(show)
  await settle()
  expect(Object.values(f.controller.layout.views)).toHaveLength(1)
  expect(Object.values(restoreWorkbenchLayout(f.controller.layout).views)).toHaveLength(0)
  f.controller.interactions.end(interactionId)
  expect(Object.values(f.controller.layout.views)).toHaveLength(0)
  f.receive({ ...show, requestId: crypto.randomUUID() })
  await settle()
  expect(Object.values(f.controller.layout.views)).toHaveLength(0)
})

it('exposes plugin short names as namespaces without publisher prefixes or global aliases', async () => {
  const f = setup()
  f.installed.value = [{ ...f.status, revision: 'next', manifest: extensionManifestSchema.parse({ ...f.status.manifest, entry: 'host.js', apiVersion: 3, contributes: { ...f.status.manifest.contributes, commands: [{ id: 'tests.music.review', title: '检查播放列表', slash: { name: 'review', description: '检查当前播放列表' } }] } }) }]
  await settle()
  expect([...f.controller.registry.commands.values()].filter(command => command.slash).map(command => command.slash)).toEqual([{ name: 'music:review', description: '检查当前播放列表', origin: { id: 'tests.music', name: 'Music', author: undefined, version: '1.0.0', source: undefined } }])
})

it.each(['slot', 'control'] as const)('acknowledges %s activation with a request UUID and keeps it out of persisted layout', async (kind) => {
  const f = setup()
  const target = kind === 'slot' ? 'composer.footer' : 'model.reasoning'
  f.status.manifest = extensionManifestSchema.parse({
    ...f.status.manifest,
    apiVersion: 3,
    permissions: { controls: ['model.reasoning'] },
    contributes: { ...f.status.manifest.contributes, placements: [{ id: 'tests.music.dock', view: 'tests.music.player', kind, target }] },
  })
  f.installed.value = [{ ...f.status }]
  f.ready.value = true
  const provider = () => f.contributions.providers(kind === 'slot' ? { kind, target: 'composer.footer' } : { kind, target: 'model.reasoning' })[0]!
  const hide = { ...f.show(), visible: false }
  f.receive(hide)
  await settle()
  expect(f.replies.get(hide.requestId)).toBe(hide.requestId)
  expect(provider().enabled).toBe(false)
  const show = f.show()
  f.receive(show)
  await settle()
  expect(f.replies.get(show.requestId)).toBe(show.requestId)
  expect(provider().enabled).toBe(true)
  expect(f.controller.layout.views).toEqual({})
  expect(f.controller.configuration.snapshot()).toEqual({})
  const invalid = { ...f.show(), instanceId: crypto.randomUUID(), visible: false }
  f.receive(invalid)
  await settle()
  expect(f.replies.get(invalid.requestId)).toBeNull()
  expect(provider().enabled).toBe(true)
})

it('persists document metadata only for its bound view and restores it independently of plugin state', async () => {
  const f = setup()
  withLauncher(f)
  f.ready.value = true
  const viewId = (await f.controller.open({ scheme: 'extension', id: 'document', data: { extensionId: f.status.manifest.id, viewType: 'tests.music.player', resource: null } }, 'Player', { viewType: 'tests.music.player', state: { version: 1, value: { documentId: 'document' } } }))!
  const session = { id: viewId, extensionId: f.status.manifest.id, generation: f.status.generation!, token: crypto.randomUUID(), url: '' }
  f.views.surfaces.set(viewId, { session } as NonNullable<ReturnType<typeof f.views.surfaces.get>>)
  const send = (title: string, dirty: boolean, token = session.token) => {
    const requestId = crypto.randomUUID()
    f.receive({ kind: 'document-info', requestId, viewId, generation: session.generation, token, info: { title, dirty } })
    return requestId
  }
  const accepted = send('季度计划.docx', true)
  await settle()
  expect(f.replies.get(accepted)).toBe(viewId)
  expect(f.controller.layout.views[viewId]).toMatchObject({ title: '季度计划.docx', state: { version: 1, value: { documentId: 'document' }, documentInfo: { title: '季度计划.docx', dirty: true } } })
  const restored = restoreWorkbenchLayout(JSON.parse(JSON.stringify(f.controller.layout)))
  expect(restored.views[viewId]?.state.documentInfo).toEqual({ title: '季度计划.docx', dirty: true })
  const stale = send('other view', false, crypto.randomUUID())
  await settle()
  expect(f.replies.get(stale)).toBeNull()
  expect(f.controller.layout.views[viewId]?.title).toBe('季度计划.docx')
  send('季度计划.docx', false)
  await settle()
  expect(f.controller.layout.views[viewId]?.state.documentInfo).toEqual({ title: '季度计划.docx', dirty: false })
})
