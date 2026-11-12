import type { JsonValue } from '../../../shared/workbench/workbenchState'
import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
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

async function fixture(permission = true) {
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
      delete: async (input) => {
        if (input.expectedRevision !== item.expectedRevision)
          throw new Error('CONVERSATION_REVISION_CONFLICT')
        records.splice(0)
        return { status: 'deleted' }
      },
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

it('denies legacy view list and delete even with permission and a valid revision', async () => {
  const f = await fixture()
  await expect(f.request('taskCleanup.list', { limit: 50 })).rejects.toThrow('EXTENSION_METHOD_DENIED')
  await expect(f.request('taskCleanup.delete', target)).rejects.toThrow('EXTENSION_METHOD_DENIED')
  expect(f.records).toEqual([item])
})

it('revokes the old session after uninstall', async () => {
  const f = await fixture()
  await f.service.uninstall(f.view.extensionId)
  await expect(f.request('taskCleanup.list', {})).rejects.toThrow('EXTENSION_VIEW_EXPIRED')
  await expect(f.request('taskCleanup.delete', target)).rejects.toThrow('EXTENSION_VIEW_EXPIRED')
  expect(f.records).toEqual([item])
})
