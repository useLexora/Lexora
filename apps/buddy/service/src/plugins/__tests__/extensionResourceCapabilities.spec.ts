import type { RuntimeRpcPeerContract } from '../../../../shared/runtime/rpcPeer'
import type { ArtifactRecord, ArtifactRepository } from '../../storage/artifactRepository'
import type { ExtensionCapabilityContext, ExtensionInvocationScope } from '../extensionAgentHandlers'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { resolveBuddyImageTransformer } from '../../../../platform/native/nativeHost'
import { extensionAgentRpc } from '../../../../shared/extensions/extensionAgent'
import { ArtifactService } from '../../artifacts/ArtifactService'
import { createExtensionResourceCapabilities } from '../extensionResourceCapabilities'

const roots: string[] = []
beforeEach(() => {
  vi.stubEnv('LEXORA_BUDDY_IMAGE_TRANSFORMER', resolveBuddyImageTransformer({ appPath: join(import.meta.dirname, '../../../..'), isPackaged: false, resourcesPath: '' }))
})
afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
async function fixture(bytes = Buffer.alloc(140_000, 7), mimeType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
  const root = await mkdtemp(join(tmpdir(), 'extension-artifact-'))
  roots.push(root)
  const records = new Map<string, ArtifactRecord>()
  const repository: ArtifactRepository = { findByCurrentPath: (conversationId, path) => [...records.values()].find(record => record.conversationId === conversationId && record.currentPath === path) ?? null, findById: id => records.get(id) ?? null, findVisibleById: id => records.get(id) ?? null, listForConversation: id => [...records.values()].filter(record => record.conversationId === id), save: (record) => {
    records.set(record.id, record)
    return record
  } }
  const artifacts = new ArtifactService({ repository })
  const controller = new AbortController()
  let current = true
  let released = false
  const resource = { id: randomUUID(), name: mimeType.startsWith('image/') ? 'page.png' : 'report.docx', mimeType, size: bytes.length }
  const requests: { offset: number, length: number }[] = []
  const scope: ExtensionInvocationScope = { conversationId: 'task', runId: 'run', extensionId: 'tests.office', invocationId: randomUUID(), signal: controller.signal, output: { access: 'write', cwd: root, grants: [{ grantId: 'task', kind: 'workspace', root, canonicalRoot: root }], images: [], imageBytes: 0, artifactIds: [] } }
  const rpc = { request: async (method: string, raw: unknown) => {
    expect(method).toBe(extensionAgentRpc.resource)
    const input = raw as { resourceId: string, offset: number, length: number }
    expect(input.length).toBeLessThanOrEqual(64 * 1024)
    if (released || input.resourceId !== resource.id)
      throw new Error('EXTENSION_RESOURCE_UNAVAILABLE')
    requests.push(input)
    return { resource, base64: bytes.subarray(input.offset, input.offset + input.length).toString('base64'), size: bytes.length, eof: input.offset + input.length >= bytes.length }
  } } as RuntimeRpcPeerContract
  const handlers = createExtensionResourceCapabilities({ rpc, artifacts }, { conversationId: 'task', branchId: 'branch', model: null, assertCurrent: () => {
    controller.signal.throwIfAborted()
    if (!current)
      throw new Error('EXTENSION_TASK_UNAVAILABLE')
  } }, scope)
  const context: ExtensionCapabilityContext = { ...scope, callNumber: 1 }
  return { handlers, scope, context, resource, requests, records, bytes, controller, revokeTask: () => current = false, release: () => released = true }
}

it('publishes the exact private bytes as an independent task output using bounded reads', async () => {
  const f = await fixture()
  expect(await f.handlers['task.scope'](null, f.context)).toEqual({ taskId: 'task', branchId: 'branch', runId: 'run' })
  const artifact = await f.handlers['artifacts.publish']({ resource: { id: f.resource.id }, name: 'final.docx' }, f.context) as { id: string }
  const record = f.records.get(artifact.id)!
  expect(record).toMatchObject({ conversationId: 'task', name: 'final.docx', sizeBytes: 140_000 })
  expect(await readFile(record.currentPath)).toEqual(f.bytes)
  expect(f.scope.output!.artifactIds).toEqual([artifact.id])
  f.release()
  expect(await readFile(record.currentPath)).toEqual(f.bytes)
})

it('denies readonly tools, actions, foreign resources, unsafe names and stale tasks without publishing', async () => {
  const f = await fixture()
  const request = { resource: { id: f.resource.id } }
  f.scope.output!.access = 'read'
  await expect(f.handlers['artifacts.publish'](request, f.context)).rejects.toThrow('EXTENSION_PERMISSION_DENIED')
  f.scope.output!.access = 'write'
  await expect(f.handlers['artifacts.publish']({ resource: { id: randomUUID() } }, f.context)).rejects.toThrow('EXTENSION_RESOURCE_UNAVAILABLE')
  await expect(f.handlers['artifacts.publish']({ ...request, name: '../outside.docx' }, f.context)).rejects.toThrow()
  f.scope.action = { id: 'tests.office.action', cause: { type: 'user' } }
  await expect(f.handlers['task.scope'](null, f.context)).rejects.toThrow('EXTENSION_PERMISSION_DENIED')
  delete f.scope.action
  f.revokeTask()
  await expect(f.handlers['artifacts.publish'](request, f.context)).rejects.toThrow('EXTENSION_TASK_UNAVAILABLE')
  expect(f.records.size).toBe(0)
  expect(f.scope.output!.artifactIds).toEqual([])
})

it('validates real PNG bytes before adding bounded native model images, never JSON base64', async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAFElEQVR4AQEJAPb/AAD/AP//AAD/EPgD/UE7EkoAAAAASUVORK5CYII=', 'base64')
  const f = await fixture(png, 'image/png')
  f.scope.output!.access = 'read'
  const result = await f.handlers['results.addImage']({ resource: { id: f.resource.id } }, f.context)
  expect(result).toBeNull()
  expect(f.scope.output!.images).toMatchObject([{ type: 'image', mimeType: 'image/png' }])
  expect(Buffer.from(f.scope.output!.images[0]!.data, 'base64').subarray(0, 8)).toEqual(png.subarray(0, 8))
  expect(f.records.size).toBe(0)
  f.release()
  await expect(f.handlers['results.addImage']({ resource: { id: f.resource.id } }, f.context)).rejects.toThrow('EXTENSION_RESOURCE_UNAVAILABLE')
  expect(f.scope.output!.images).toHaveLength(1)
})

it('rejects malformed images and aborts before consuming a resource', async () => {
  const f = await fixture(Buffer.from('not a PNG'), 'image/png')
  await expect(f.handlers['results.addImage']({ resource: { id: f.resource.id } }, f.context)).rejects.toThrow()
  expect(f.scope.output!.images).toEqual([])
  const count = f.requests.length
  f.controller.abort()
  await expect(f.handlers['results.addImage']({ resource: { id: f.resource.id } }, f.context)).rejects.toThrow()
  expect(f.requests).toHaveLength(count)
})
