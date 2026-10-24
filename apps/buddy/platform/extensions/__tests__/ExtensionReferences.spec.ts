import type { ExtensionResource, ExtensionViewInput, ExtensionViewSession, ExtensionWorkbenchEvent } from '../../../shared/extensions/extensionApi'
import type { ExtensionManifest } from '../../../shared/extensions/extensionManifest'
import type { ExtensionReferenceTarget } from '../../../shared/extensions/extensionReferences'
import type { ExtensionServicePorts } from '../ExtensionService'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { deferred } from '@buddy-tests/deferred'
import { afterEach, expect, it } from 'vitest'
import { BUDDY_ATTACHMENT_TOTAL_BYTES_LIMIT } from '../../../shared/conversation/attachmentPolicy'
import { buddyViewQuoteSchema } from '../../../shared/conversation/buddyUserContent'
import { ExtensionService } from '../ExtensionService'
import { createStore, manifest, reviewPackage } from './fixtures'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
const extensionId = 'tests.reader'
const viewType = 'tests.reader.view'
const target = { spaceId: 'space', directoryId: 'directory', revision: 4, path: 'document.md' }
const referenceTarget: ExtensionReferenceTarget = { extensionId, viewId: randomUUID(), viewType, source: { kind: 'space', target } }
const content = { kind: 'content', title: 'Selected paragraph', text: 'A selected passage', locator: { version: 1, data: { block: 'opaque-block', offset: 7 } } }
function referenceManifest(references = true, localResources = true) {
  return manifest({ apiVersion: 4, permissions: { references, selectedResource: 'read', localResources, windowEffects: true }, contributes: {
    views: [
      { id: viewType, title: 'Reader', entry: 'view.js', resource: 'optional-file' },
      { id: 'tests.reader.required', title: 'Required', entry: 'view.js', resource: 'selected-file' },
      { id: 'tests.reader.empty', title: 'Empty', entry: 'view.js', resource: 'none' },
      { id: 'tests.reader.page', title: 'Page', entry: 'view.js', resource: 'none', location: 'page' },
    ],
    placements: [
      { id: 'tests.reader.decoration', view: 'tests.reader.empty', kind: 'decoration', anchor: 'composer.input' },
      { id: 'tests.reader.slot', view: 'tests.reader.empty', kind: 'slot', target: 'composer.footer' },
    ],
    fileHandlers: [{ id: 'tests.reader.files', title: 'Reader', extensions: ['.md'], preview: { view: viewType } }],
  } })
}
async function fixture(overrides: Partial<ExtensionServicePorts> = {}, value: ExtensionManifest = referenceManifest()) {
  const f = await createStore()
  cleanups.push(() => rm(f.root, { recursive: true, force: true }))
  await f.store.install((await reviewPackage(f.root, f.store, value)).token)
  const events: Extract<ExtensionWorkbenchEvent, { kind: 'reference' }>[] = []
  let authorized = true
  const assertAuthorized = () => {
    if (!authorized)
      throw new Error('EXTENSION_RESOURCE_DENIED')
  }
  const service = new ExtensionService(f.store, {
    createHost: () => ({ call: async () => null, dispose: async () => {}, devtools: () => {} }),
    createView: () => ({ token: randomUUID(), url: 'lexora-extension://fixture/__view.html', dispose: () => {} }),
    workbench: async (event) => {
      if (event.kind === 'reference') {
        events.push(event)
        return event.viewId
      }
      return null
    },
    readText: async () => {
      assertAuthorized()
      return 'saved text'
    },
    readResource: async () => {
      assertAuthorized()
      return new Response('saved text', { headers: { 'content-type': 'text/markdown' } })
    },
    readArtifactResource: async (id) => {
      assertAuthorized()
      if (id !== 'artifact')
        throw new Error('EXTENSION_RESOURCE_DENIED')
      return { name: 'output.md', response: new Response('artifact bytes', { headers: { 'content-type': 'text/markdown' } }) }
    },
    get: async () => new Response(''),
    ...overrides,
  })
  cleanups.push(() => service.dispose())
  const open = (resource: ExtensionResource | null = null, extra: Partial<ExtensionViewInput> = {}) => service.openView({ extensionId, viewType, resource, viewId: randomUUID(), state: {}, stateVersion: 1, ...extra })
  const call = (view: ExtensionViewSession, input: unknown = content) => service.viewRequest(view.id, view.generation, view.token, 'references.add', input)
  return { ...f, service, events, open, call, revoke: () => {
    authorized = false
  } }
}

it('constructs owned quote provenance and waits for the exact renderer acceptance', async () => {
  const requested = deferred<ExtensionWorkbenchEvent>()
  const reply = deferred<string | null>()
  const f = await fixture({ workbench: async (event) => {
    requested.resolve(event)
    return reply.promise
  } })
  const prepared = await f.service.prepareReferenceOpening(referenceTarget)
  const view = await f.open(prepared.resource)
  let settled = false
  const adding = f.call(view).then((value) => {
    settled = true
    return value
  })
  const event = await requested.promise
  expect(settled).toBe(false)
  expect(event).toMatchObject({ kind: 'reference', viewId: view.id, generation: view.generation, token: view.token, material: {
    kind: 'quote',
    quote: { text: content.text, locator: content.locator, source: { kind: 'view', title: content.title, provider: 'extension:tests.reader', target: { ...referenceTarget, viewId: view.id } } },
  } })
  if (event.kind !== 'reference' || event.material.kind !== 'quote')
    throw new Error('Expected quote')
  expect(buddyViewQuoteSchema.parse(event.material.quote).id).toBeTruthy()
  reply.resolve(view.id)
  expect(await adding).toBe(true)
})

it.each([null, 'another-view'])('returns false without retrying when the renderer declines: %s', async (reply) => {
  const events: ExtensionWorkbenchEvent[] = []
  const f = await fixture({ workbench: async (event) => {
    events.push(event)
    return reply
  } })
  expect(await f.call(await f.open())).toBe(false)
  expect(events).toHaveLength(1)
})

it('keeps separate no-file source instances distinct without trusting plugin-supplied identity', async () => {
  const f = await fixture()
  const first = await f.open()
  const second = await f.open()
  expect(await f.call(first)).toBe(true)
  expect(await f.call(second)).toBe(true)
  expect(f.events.map(event => event.material)).toMatchObject([
    { kind: 'quote', quote: { source: { target: { viewId: first.id, source: null } } } },
    { kind: 'quote', quote: { source: { target: { viewId: second.id, source: null } } } },
  ])
  await expect(f.call(first, { ...content, viewId: second.id })).rejects.toThrow('EXTENSION_INVALID_ARGUMENT')
})

it('requires the API 4 references permission and rejects non-interactive placements', async () => {
  const denied = await fixture({}, referenceManifest(false))
  await expect(denied.call(await denied.open())).rejects.toThrow('EXTENSION_REFERENCES_DENIED')
  expect(denied.events).toEqual([])
  const f = await fixture()
  for (const extra of [
    { viewType: 'tests.reader.empty', placementId: 'tests.reader.decoration' },
    { viewType: 'tests.reader.empty', placementId: 'tests.reader.slot' },
  ]) {
    await expect(f.call(await f.open(null, extra))).rejects.toThrow('EXTENSION_METHOD_DENIED')
  }
  expect(f.events).toEqual([])
})

it('keeps ordinary Space references but copies unsaved selected and artifact bytes', async () => {
  const f = await fixture()
  const saved = await f.service.prepareReferenceOpening(referenceTarget)
  const savedView = await f.open(saved.resource)
  expect(await f.call(savedView, { kind: 'resource', resource: { id: saved.resource!.id } })).toBe(true)
  expect(f.events.at(-1)?.material).toEqual({ kind: 'source', source: { spaceId: target.spaceId, bindingId: target.directoryId, relativePath: target.path } })
  const unsaved = await f.service.prepareFileOpening({ providerId: 'tests.reader.files', location: 'inline', source: referenceTarget.source, text: 'unsaved content' })
  const temporaryView = await f.open(unsaved.resource)
  expect(await f.call(temporaryView, { kind: 'resource', resource: { id: unsaved.resource!.id } })).toBe(true)
  expect(f.events.at(-1)?.material).toEqual({ kind: 'file', name: 'document.md', mimeType: 'text/markdown', base64: Buffer.from('unsaved content').toString('base64') })
  const artifact = await f.service.prepareReferenceOpening({ ...referenceTarget, source: { kind: 'artifact', artifactId: 'artifact' } })
  expect(await f.call(await f.open(artifact.resource), { kind: 'resource', resource: { id: artifact.resource!.id } })).toBe(true)
  expect(f.events.at(-1)?.material).toEqual({ kind: 'file', name: 'output.md', mimeType: 'text/markdown', base64: Buffer.from('artifact bytes').toString('base64') })
  f.revoke()
  await expect(f.call(savedView)).rejects.toThrow('EXTENSION_RESOURCE_DENIED')
  await expect(f.call(temporaryView, { kind: 'resource', resource: { id: unsaved.resource!.id } })).rejects.toThrow('EXTENSION_RESOURCE_DENIED')
  expect(f.events).toHaveLength(3)
})

it('rejects another view selected handle and copies local resources only while authorized', async () => {
  const f = await fixture()
  const selected = await f.service.prepareReferenceOpening(referenceTarget)
  await f.open(selected.resource)
  const other = await f.open()
  await expect(f.call(other, { kind: 'resource', resource: { id: selected.resource!.id } })).rejects.toThrow('EXTENSION_RESOURCE_DENIED')
  const path = join(f.root, 'local.txt')
  await writeFile(path, 'local bytes')
  const [local] = await f.store.resources.grant(extensionId, [path], () => {})
  expect(await f.call(other, { kind: 'resource', resource: { id: local!.id } })).toBe(true)
  expect(f.events.at(-1)?.material).toEqual({ kind: 'file', name: 'local.txt', mimeType: 'text/plain', base64: Buffer.from('local bytes').toString('base64') })
  expect(JSON.stringify(f.events)).not.toContain(f.root)
  await f.store.resources.revoke(extensionId, local!.id, () => {})
  await expect(f.call(other, { kind: 'resource', resource: { id: local!.id } })).rejects.toThrow('EXTENSION_RESOURCE_DENIED')
})

it('allows private snapshots without granting local file access', async () => {
  const f = await fixture({}, referenceManifest(true, false))
  const view = await f.open()
  const path = join(f.root, 'local.txt')
  await writeFile(path, 'not authorized')
  const [local] = await f.store.resources.grant(extensionId, [path], () => {})
  await expect(f.call(view, { kind: 'resource', resource: { id: local!.id } })).rejects.toThrow('EXTENSION_RESOURCE_DENIED')
  const owned = await f.store.resources.import(extensionId, 'owned.txt', 'text/plain', new Response('private'), new AbortController().signal, () => {})
  expect(await f.call(view, { kind: 'resource', resource: { id: owned.id } })).toBe(true)
  expect(f.events.at(-1)?.material).toMatchObject({ kind: 'file', name: 'owned.txt', base64: Buffer.from('private').toString('base64') })
})

it('bounds attachment snapshot bytes and does not publish an oversized resource', async () => {
  let cancelled = false
  let large = false
  const f = await fixture({ readArtifactResource: async () => ({ name: 'output.bin', response: large
    ? new Response(new ReadableStream<Uint8Array>({
        pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024)) },
        cancel() { cancelled = true },
      }), { headers: { 'content-length': String(BUDDY_ATTACHMENT_TOTAL_BYTES_LIMIT + 1) } })
    : new Response('small') }) })
  const prepared = await f.service.prepareReferenceOpening({ ...referenceTarget, source: { kind: 'artifact', artifactId: 'artifact' } })
  const view = await f.open(prepared.resource)
  large = true
  await expect(f.call(view, { kind: 'resource', resource: { id: prepared.resource!.id } })).rejects.toThrow()
  expect(cancelled).toBe(true)
  expect(f.events).toEqual([])
})

it('invalidates a pending material before delivery when its view closes', async () => {
  const response = deferred<Response>()
  const reading = deferred<void>()
  let pending = false
  const f = await fixture({ readResource: async () => {
    if (!pending)
      return new Response('saved')
    reading.resolve()
    return response.promise
  } })
  const prepared = await f.service.prepareReferenceOpening(referenceTarget)
  const view = await f.open(prepared.resource)
  pending = true
  const adding = f.call(view)
  const rejected = expect(adding).rejects.toThrow()
  await reading.promise
  f.service.closeView(view.id, view.generation, view.token)
  response.resolve(new Response('late'))
  await rejected
  expect(f.events).toEqual([])
})

it.each(['close', 'disable'] as const)('invalidates a renderer reply after %s without retrying', async (operation) => {
  const requested = deferred<void>()
  const reply = deferred<string | null>()
  let signal: AbortSignal | undefined
  const f = await fixture({ workbench: async (_event, current) => {
    signal = current
    requested.resolve()
    return reply.promise
  } })
  const view = await f.open()
  const adding = f.call(view)
  const rejected = expect(adding).rejects.toThrow(operation === 'close' ? 'EXTENSION_VIEW_EXPIRED' : 'EXTENSION_HOST_STOPPED')
  await requested.promise
  if (operation === 'close')
    f.service.closeView(view.id, view.generation, view.token)
  else
    await f.service.enable(extensionId, false)
  expect(signal?.aborted).toBe(true)
  reply.resolve(view.id)
  await rejected
})

it('accepts a registered page selection, reopens its source and rejects a revoked page session', async () => {
  const value = referenceManifest()
  value.contributes.navigation = { title: 'Reader', view: 'tests.reader.page', showHeader: true }
  const f = await fixture({}, value)
  const view = await f.open(null, { viewType: 'tests.reader.page' })
  expect(await f.call(view)).toBe(true)
  expect(f.events[0]).toMatchObject({ kind: 'reference', viewId: view.id, material: {
    kind: 'quote',
    quote: { text: content.text, source: { provider: 'extension:tests.reader', target: { extensionId, viewId: view.id, viewType: 'tests.reader.page', source: null } } },
  } })
  const pageTarget = { ...referenceTarget, viewId: view.id, viewType: 'tests.reader.page', source: null }
  expect(await f.service.prepareReferenceOpening(pageTarget)).toEqual({ extensionId, viewType: 'tests.reader.page', resource: null })
  const reuse = { id: view.id, generation: view.generation, token: view.token }
  expect(await f.service.prepareReferenceOpening({ ...pageTarget, reuse })).toEqual({ extensionId, viewType: 'tests.reader.page', resource: null })
  await expect(f.service.prepareReferenceOpening({ ...pageTarget, source: referenceTarget.source })).rejects.toThrow('EXTENSION_RESOURCE_DENIED')
  f.service.closeView(view.id, view.generation, view.token)
  await expect(f.call(view)).rejects.toThrow('EXTENSION_VIEW_EXPIRED')
  await expect(f.service.prepareReferenceOpening({ ...pageTarget, reuse })).rejects.toThrow('EXTENSION_REFERENCE_UNAVAILABLE')
  const denied = await fixture({}, referenceManifest(false))
  await expect(denied.call(await denied.open(null, { viewType: 'tests.reader.page' }))).rejects.toThrow('EXTENSION_REFERENCES_DENIED')
})

it('prepares only compatible owned context views, reissues handles and rechecks source authorization', async () => {
  const f = await fixture()
  const first = await f.service.prepareReferenceOpening(referenceTarget)
  const second = await f.service.prepareReferenceOpening(referenceTarget)
  expect(first.resource!.id).not.toBe(second.resource!.id)
  expect(await f.service.prepareReferenceOpening({ ...referenceTarget, source: null })).toEqual({ extensionId, viewType, resource: null })
  for (const viewType of ['other.reader.view', 'tests.reader.page', 'tests.reader.missing'])
    await expect(f.service.prepareReferenceOpening({ ...referenceTarget, viewType })).rejects.toThrow('EXTENSION_REFERENCE_UNAVAILABLE')
  await expect(f.service.prepareReferenceOpening({ ...referenceTarget, viewType: 'tests.reader.required', source: null })).rejects.toThrow('EXTENSION_RESOURCE_REQUIRED')
  await expect(f.service.prepareReferenceOpening({ ...referenceTarget, viewType: 'tests.reader.empty' })).rejects.toThrow('EXTENSION_RESOURCE_DENIED')
  f.revoke()
  await expect(f.service.prepareReferenceOpening(referenceTarget)).rejects.toThrow('EXTENSION_RESOURCE_DENIED')
  await f.service.enable(extensionId, false)
  await expect(f.service.prepareReferenceOpening({ ...referenceTarget, source: null })).rejects.toThrow()
  await f.service.enable(extensionId, true)
  f.store.installed[extensionId]!.current.manifest.engines.lexora = '>=99.0.0'
  await expect(f.service.prepareReferenceOpening({ ...referenceTarget, source: null })).rejects.toThrow('EXTENSION_INCOMPATIBLE')
})

it('reuses an authorized live view and its unsaved snapshot without issuing a new handle', async () => {
  const f = await fixture()
  const prepared = await f.service.prepareFileOpening({ providerId: 'tests.reader.files', location: 'inline', source: referenceTarget.source!, text: 'unsaved working copy' })
  const view = await f.open(prepared.resource)
  const reuse = { id: view.id, generation: view.generation, token: view.token }
  expect(await f.service.prepareReferenceOpening({ ...referenceTarget, reuse })).toEqual(prepared)
  expect(await f.service.viewRequest(view.id, view.generation, view.token, 'resources.readText', { id: prepared.resource!.id })).toBe('unsaved working copy')
  await expect(f.service.prepareReferenceOpening({ ...referenceTarget, source: { kind: 'artifact', artifactId: 'artifact' }, reuse })).rejects.toThrow('EXTENSION_RESOURCE_DENIED')
  await expect(f.service.prepareReferenceOpening({ ...referenceTarget, reuse: { ...reuse, token: 'stale' } })).rejects.toThrow('EXTENSION_REFERENCE_UNAVAILABLE')
  f.revoke()
  await expect(f.service.prepareReferenceOpening({ ...referenceTarget, reuse })).rejects.toThrow('EXTENSION_RESOURCE_DENIED')
})

it('rejects a reused view closed while its authorization is being rechecked', async () => {
  const read = deferred<void>()
  const checked = deferred<void>()
  let delay = false
  const f = await fixture({ readResource: async () => {
    if (delay) {
      checked.resolve()
      await read.promise
    }
    return new Response('saved text')
  } })
  const prepared = await f.service.prepareReferenceOpening(referenceTarget)
  const view = await f.open(prepared.resource)
  delay = true
  const opening = f.service.prepareReferenceOpening({ ...referenceTarget, reuse: { id: view.id, generation: view.generation, token: view.token } })
  const rejected = expect(opening).rejects.toThrow()
  await checked.promise
  f.service.closeView(view.id, view.generation, view.token)
  read.resolve()
  await rejected
})

it('detaches explicit view content from the imported resource without restoring its file authorization', async () => {
  const f = await fixture()
  const prepared = await f.service.prepareReferenceOpening(referenceTarget)
  const view = await f.open(prepared.resource)
  expect(await f.call(view)).toBe(true)
  expect(f.events.at(-1)?.material).toMatchObject({ kind: 'quote', quote: { source: { target: { source: referenceTarget.source } } } })
  f.revoke()
  await expect(f.call(view)).rejects.toThrow('EXTENSION_RESOURCE_DENIED')
  expect(await f.call(view, { ...content, source: 'view', locator: { version: 1, data: { documentId: 'private-document-b' } } })).toBe(true)
  const material = f.events.at(-1)!.material
  if (material.kind !== 'quote')
    throw new Error('Expected quote')
  expect(material.quote).toMatchObject({ source: { target: { extensionId, viewType, viewId: view.id, source: null } }, locator: { data: { documentId: 'private-document-b' } } })
  const target = material.quote.source.target as ExtensionReferenceTarget
  expect(await f.service.prepareReferenceOpening({ ...target, reuse: { id: view.id, generation: view.generation, token: view.token } })).toEqual(prepared)
  await expect(f.service.viewRequest(view.id, view.generation, view.token, 'resources.readText', { id: prepared.resource!.id })).rejects.toThrow('EXTENSION_RESOURCE_DENIED')
  f.service.closeView(view.id, view.generation, view.token)
  const reopened = await f.service.prepareReferenceOpening(target)
  expect(reopened).toEqual({ extensionId, viewType, resource: null })
  const restored = await f.open(reopened.resource)
  expect(await f.call(restored, { ...content, source: 'view' })).toBe(true)
})

it('allows explicit view provenance only when the view can reopen without a selected file', async () => {
  const f = await fixture()
  expect(await f.call(await f.open(null, { viewType: 'tests.reader.empty' }), { ...content, source: 'view' })).toBe(true)
  const prepared = await f.service.prepareReferenceOpening({ ...referenceTarget, viewType: 'tests.reader.required' })
  const required = await f.open(prepared.resource, { viewType: prepared.viewType })
  await expect(f.call(required, { ...content, source: 'view' })).rejects.toThrow('EXTENSION_RESOURCE_REQUIRED')
  expect(await f.call(required)).toBe(true)
  await expect(f.service.prepareReferenceOpening({ ...referenceTarget, viewType: prepared.viewType, source: null, reuse: { id: required.id, generation: required.generation, token: required.token } })).rejects.toThrow('EXTENSION_RESOURCE_REQUIRED')
})
