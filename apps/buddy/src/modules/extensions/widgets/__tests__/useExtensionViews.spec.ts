import type { ExtensionApi, ExtensionStatus, ExtensionViewInput, ExtensionViewSession } from '@buddy-shared/extensions/extensionApi'
// @vitest-environment jsdom
import type { WorkbenchContextValues } from '@buddy-shared/workbench/workbenchContext'
import type { ExtensionControlBinding } from '../useExtensionViews'
import { extensionManifestSchema } from '@buddy-shared/extensions/extensionManifest'
import { deferred } from '@buddy-tests/deferred'
import { afterEach, expect, it, vi } from 'vitest'
import { effectScope, shallowRef } from 'vue'
import { useExtensionViews } from '../useExtensionViews'

const scopes: ReturnType<typeof effectScope>[] = []
afterEach(() => scopes.splice(0).forEach(scope => scope.stop()))
function setup() {
  const status: ExtensionStatus = { manifest: extensionManifestSchema.parse({ schemaVersion: 1, id: 'tests.view', name: 'View', version: '1.0.0', apiVersion: 2, engines: { lexora: '*' }, contributes: {} }), revision: 'first', enabled: true, compatible: true, development: false, pending: null, state: 'active', generation: crypto.randomUUID(), error: null, activationMs: null, logs: [] }
  const installed = shallowRef([status])
  const context = shallowRef<WorkbenchContextValues>({ 'page.id': 'lexora.tasks' })
  const input: ExtensionViewInput = { extensionId: status.manifest.id, viewId: crypto.randomUUID(), viewType: 'tests.view.first', state: {}, stateVersion: 0, resource: null }
  const requests: ReturnType<typeof deferred<ExtensionViewSession>>[] = []
  const closed: string[] = []
  const api: Partial<ExtensionApi> = {
    openView: () => {
      const request = deferred<ExtensionViewSession>()
      requests.push(request)
      return request.promise
    },
    closeView: async (_id, _generation, token) => { closed.push(token) },
    viewRequest: async () => null,
  }
  const scope = effectScope()
  scopes.push(scope)
  const views = scope.run(() => useExtensionViews(api as ExtensionApi, installed, context))!
  const session = (generation = status.generation!): ExtensionViewSession => ({ id: input.viewId, extensionId: input.extensionId, generation, token: crypto.randomUUID(), url: 'about:blank' })
  const show = (next = input, control?: ExtensionControlBinding) => views.show(next, document.createElement('div'), true, { control })
  return { context, views, scope, installed, status, input, requests, closed, session, show }
}

it('defers an ineligible view and retains its session and state across page changes', async () => {
  const f = setup()
  f.status.manifest.contributes.views.push({ id: f.input.viewType, title: 'Scoped', entry: 'ui.js', resource: 'none', location: 'context', stateVersion: 1, when: { 'page.id': ['lexora.tasks', 'future.canvas'] } })
  f.context.value = { 'page.id': 'lexora.settings' }
  f.show()
  expect(f.requests).toHaveLength(0)
  expect(f.views.surfaces.get(f.input.viewId)).toMatchObject({ eligible: false, session: null })
  f.context.value = { 'page.id': 'lexora.tasks' }
  const session = f.session()
  f.requests[0]!.resolve(session)
  await Promise.resolve()
  f.show({ ...f.input, state: { cursor: 42 } })
  f.context.value = { 'page.id': 'lexora.settings' }
  expect(f.views.surfaces.get(f.input.viewId)).toMatchObject({ eligible: false, session, input: { state: { cursor: 42 } } })
  f.context.value = { 'page.id': 'future.canvas' }
  expect(f.views.surfaces.get(f.input.viewId)).toMatchObject({ eligible: true, session, input: { state: { cursor: 42 } } })
  expect(f.closed).toEqual([])
  expect(f.requests).toHaveLength(1)
})

it('discards a late open from an obsolete view definition without replacing the current session', async () => {
  const fixture = setup()
  fixture.show()
  fixture.show({ ...fixture.input, viewType: 'tests.view.second' })
  const old = fixture.session()
  const current = fixture.session()
  fixture.requests[1]!.resolve(current)
  await Promise.resolve()
  fixture.requests[0]!.resolve(old)
  await Promise.resolve()
  expect(fixture.views.surfaces.get(fixture.input.viewId)?.session).toEqual(current)
  expect(fixture.closed).toEqual([old.token])
})

it('does not reopen a view for saved state, layout changes or unrelated status refreshes', async () => {
  const fixture = setup()
  fixture.show()
  const session = fixture.session()
  fixture.requests[0]!.resolve(session)
  await Promise.resolve()
  fixture.show({ ...fixture.input, state: { volume: 0.37 } })
  fixture.installed.value = [{ ...fixture.status }]
  expect(fixture.requests).toHaveLength(1)
  expect(fixture.views.surfaces.get(fixture.input.viewId)?.session).toEqual(session)
})

it('keeps a failed view stopped until its host generation changes', async () => {
  const fixture = setup()
  fixture.show()
  fixture.requests[0]!.resolve(fixture.session())
  await Promise.resolve()
  const surface = fixture.views.surfaces.get(fixture.input.viewId)!
  fixture.views.fail(surface, 'EXTENSION_VIEW_TIMEOUT')
  fixture.installed.value = [{ ...fixture.status }]
  fixture.show()
  expect(fixture.requests).toHaveLength(1)
  expect(surface.error).toBe('EXTENSION_VIEW_TIMEOUT')
  fixture.installed.value = [{ ...fixture.status, generation: crypto.randomUUID() }]
  expect(fixture.requests).toHaveLength(2)
  expect(surface.error).toBe('')
})

it('invalidates pending opens on disable and disposes sessions returned after unmount', async () => {
  const fixture = setup()
  fixture.show()
  fixture.installed.value = [{ ...fixture.status, enabled: false, state: 'disabled', generation: null }]
  const obsolete = fixture.session()
  fixture.requests[0]!.resolve(obsolete)
  await Promise.resolve()
  expect(fixture.views.surfaces.get(fixture.input.viewId)?.session).toBeNull()
  expect(fixture.closed).toContain(obsolete.token)
  fixture.installed.value = [fixture.status]
  fixture.scope.stop()
  const late = fixture.session()
  fixture.requests[1]!.resolve(late)
  await Promise.resolve()
  expect(fixture.views.surfaces.size).toBe(0)
  expect(fixture.closed).toContain(late.token)
})

it('rejects a proposal from the replaced session even within one host generation', async () => {
  const fixture = setup()
  fixture.show()
  const session = fixture.session()
  fixture.requests[0]!.resolve(session)
  await Promise.resolve()
  const surface = fixture.views.surfaces.get(fixture.input.viewId)!
  const propose = vi.fn(() => true)
  surface.ready = true
  surface.control = { snapshot: vi.fn(), dismiss: vi.fn(), propose }
  const proposal = { revision: crypto.randomUUID(), value: 'high' }
  expect(fixture.views.proposeControl(session.id, session.generation, crypto.randomUUID(), proposal)).toBe(false)
  expect(fixture.views.proposeControl(session.id, session.generation, session.token, proposal)).toBe(true)
  surface.visible = false
  expect(fixture.views.proposeControl(session.id, session.generation, session.token, proposal)).toBe(false)
})

it('retains control opening failures across remounts without blocking another placement', async () => {
  const fixture = setup()
  const control: ExtensionControlBinding = { snapshot: () => ({ revision: 'revision', value: 'low', options: [], disabled: false }), dismiss: () => {}, propose: () => false }
  const input = { ...fixture.input, placementId: 'tests.view.control' }
  fixture.installed.value = [{ ...fixture.status, state: 'activating', generation: null }]
  fixture.show(input, control)
  fixture.requests[0]!.reject(new Error('EXTENSION_VIEW_TIMEOUT'))
  await Promise.resolve()
  fixture.views.hide(input.viewId)
  fixture.installed.value = [fixture.status]
  const remounted = { ...input, viewId: crypto.randomUUID() }
  fixture.show(remounted, control)
  expect(fixture.views.surfaces.get(remounted.viewId)?.error).toBe('EXTENSION_VIEW_TIMEOUT')
  expect(fixture.requests).toHaveLength(1)
  const unrelated = { ...input, viewId: crypto.randomUUID(), placementId: 'tests.view.other' }
  fixture.show(unrelated, control)
  const session = { ...fixture.session(), id: unrelated.viewId }
  fixture.requests[1]!.resolve(session)
  await Promise.resolve()
  expect(fixture.views.surfaces.get(unrelated.viewId)?.session).toEqual(session)
  expect(fixture.views.surfaces.get(remounted.viewId)?.session).toBeNull()
  fixture.installed.value = [{ ...fixture.status, generation: crypto.randomUUID() }]
  expect(fixture.views.surfaces.get(remounted.viewId)?.error).toBe('')
  expect(fixture.views.surfaces.get(remounted.viewId)?.opening).toBe(true)
})
