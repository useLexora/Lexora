import type { ExtensionTaskCleanupDelete, ExtensionTaskCleanupResult } from '../../../shared/extensions/extensionTaskCleanup'
import type { JsonValue } from '../../../shared/workbench/workbenchState'
import type { ExtensionServicePorts } from '../ExtensionService'
import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { deferred } from '@buddy-tests/deferred'
import { afterEach, expect, it } from 'vitest'
import { addedExtensionPermissions, extensionManifestSchema, extensionPermissionsSchema } from '../../../shared/extensions/extensionManifest'
import { ExtensionService } from '../ExtensionService'
import { createStore, manifest, reviewPackage } from './fixtures'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
const target = { conversationId: 'legacy-task', expectedRevision: 4 }
const item = { ...target, title: 'Legacy task', removedAt: '2026-01-01T00:00:00Z', estimatedBytes: null, canDelete: true, blockedReason: null }

async function fixture(permission = true, confirmation: NonNullable<ExtensionServicePorts['taskCleanup']>['confirmDelete'] = async () => true, execute?: (input: ExtensionTaskCleanupDelete) => Promise<ExtensionTaskCleanupResult>) {
  const { root, store } = await createStore()
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const definition = manifest({ apiVersion: 4, permissions: { legacyTaskCleanup: permission }, contributes: { views: [{ id: 'tests.reader.page', title: 'Cleanup', entry: 'view.js', location: 'page', resource: 'none' }] } })
  await store.install((await reviewPackage(root, store, definition)).token)
  const records = [item]
  let broker!: (method: string, params: unknown) => Promise<JsonValue>
  const service = new ExtensionService(store, {
    createHost: (_pkg, call) => {
      broker = call
      return { call: async () => null, dispose: async () => {}, devtools: () => {} }
    },
    createView: () => ({ token: randomUUID(), url: 'lexora-extension://fixture/__view.html', dispose: () => {} }),
    workbench: async () => null,
    readText: async () => '',
    get: async () => new Response(''),
    taskCleanup: {
      list: async () => ({ items: records, nextCursor: null }),
      delete: execute ?? (async (input) => {
        if (input.expectedRevision !== item.expectedRevision)
          throw new Error('CONVERSATION_REVISION_CONFLICT')
        records.splice(0)
        return { status: 'deleted' }
      }),
      confirmDelete: confirmation,
    },
  })
  cleanups.push(() => service.dispose())
  const view = await service.openView({ viewId: randomUUID(), extensionId: definition.id, viewType: 'tests.reader.page', resource: null, state: null, stateVersion: 1 })
  return { service, records, view, broker: (method: string, params: unknown) => broker(method, params), request: (method: string, params: unknown) => service.viewRequest(view.id, view.generation, view.token, method, params) }
}

it('requires API 4 and an interactive view for legacy cleanup permission', () => {
  const definition = manifest({ apiVersion: 4, permissions: { legacyTaskCleanup: true }, contributes: { views: [{ id: 'tests.reader.page', title: 'Cleanup', entry: 'view.js', location: 'page', resource: 'none' }] } })
  expect(extensionManifestSchema.safeParse(definition).success).toBe(true)
  expect(extensionManifestSchema.safeParse({ ...definition, apiVersion: 3 }).success).toBe(false)
  expect(extensionManifestSchema.safeParse({ ...definition, contributes: {} }).success).toBe(false)
})

it('requires an explicitly reviewed permission and denies background access', async () => {
  expect(extensionPermissionsSchema.parse({}).legacyTaskCleanup).toBe(false)
  expect(addedExtensionPermissions(extensionPermissionsSchema.parse({}), extensionPermissionsSchema.parse({ legacyTaskCleanup: true }))).toContain('legacyTaskCleanup')
  const denied = await fixture(false)
  await expect(denied.request('taskCleanup.list', {})).rejects.toThrow('EXTENSION_METHOD_DENIED')
  await expect(denied.request('taskCleanup.delete', target)).rejects.toThrow('EXTENSION_METHOD_DENIED')
  expect(denied.records).toEqual([item])
  const allowed = await fixture()
  await expect(allowed.request('taskCleanup.run', { token: randomUUID() })).rejects.toThrow('EXTENSION_METHOD_DENIED')
  await expect(allowed.broker('taskCleanup.run', { token: randomUUID() })).rejects.toThrow('EXTENSION_METHOD_DENIED')
  await expect(allowed.broker('taskCleanup.delete', target)).rejects.toThrow('EXTENSION_METHOD_DENIED')
  expect(allowed.records).toEqual([item])
})

it('exposes only the bounded metadata page and accepts exact confirmed targets', async () => {
  const f = await fixture()
  expect(await f.request('taskCleanup.list', { limit: 50 })).toEqual({ items: [item], nextCursor: null })
  for (const input of [{ kind: 'archived' }, { limit: 101 }, { path: '/tmp' }])
    await expect(f.request('taskCleanup.list', input)).rejects.toThrow('EXTENSION_INVALID_ARGUMENT')
  for (const input of [{ conversationId: 'legacy-task' }, { ...target, kind: 'archived' }, { ...target, path: '/tmp' }])
    await expect(f.request('taskCleanup.delete', input)).rejects.toThrow('EXTENSION_INVALID_ARGUMENT')
  expect(f.records).toEqual([item])
  expect(await f.request('taskCleanup.delete', target)).toEqual({ status: 'deleted' })
  expect(f.records).toEqual([])
})

it('does not delete after cancellation or a stale revision', async () => {
  const cancelled = await fixture(true, async () => false)
  await expect(cancelled.request('taskCleanup.delete', target)).rejects.toThrow('EXTENSION_TASK_CLEANUP_CANCELLED')
  expect(cancelled.records).toEqual([item])
  const stale = await fixture()
  await expect(stale.request('taskCleanup.delete', { ...target, expectedRevision: 3 })).rejects.toThrow('CONVERSATION_REVISION_CONFLICT')
  expect(stale.records).toEqual([item])
})

it('revokes a pending confirmation when its view closes', async () => {
  const confirmed = deferred<boolean>()
  const started = deferred<void>()
  const f = await fixture(true, async () => {
    started.resolve()
    return confirmed.promise
  })
  const result = f.request('taskCleanup.delete', target)
  const rejected = expect(result).rejects.toThrow('EXTENSION_VIEW_EXPIRED')
  await started.promise
  f.service.closeView(f.view.id, f.view.generation, f.view.token)
  confirmed.resolve(true)
  await rejected
  expect(f.records).toEqual([item])
})

it('revokes the old session after uninstall', async () => {
  const f = await fixture()
  await f.service.uninstall(f.view.extensionId)
  await expect(f.request('taskCleanup.list', {})).rejects.toThrow('EXTENSION_VIEW_EXPIRED')
  await expect(f.request('taskCleanup.delete', target)).rejects.toThrow('EXTENSION_VIEW_EXPIRED')
  expect(f.records).toEqual([item])
})

it('does not cancel a core deletion already accepted when the view closes', async () => {
  const accepted = deferred<void>()
  const complete = deferred<void>()
  const deleted: string[] = []
  const f = await fixture(true, async () => true, async (input) => {
    accepted.resolve()
    await complete.promise
    deleted.push(input.conversationId)
    return { status: 'deleted' }
  })
  const result = f.request('taskCleanup.delete', target)
  const rejected = expect(result).rejects.toThrow('EXTENSION_VIEW_EXPIRED')
  await accepted.promise
  f.service.closeView(f.view.id, f.view.generation, f.view.token)
  complete.resolve()
  await rejected
  expect(deleted).toEqual(['legacy-task'])
})
