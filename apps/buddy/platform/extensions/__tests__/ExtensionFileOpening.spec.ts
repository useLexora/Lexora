import type { ExtensionServicePorts } from '../ExtensionService'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { cp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { deferred } from '@buddy-tests/deferred'
import { afterEach, expect, it } from 'vitest'
import { extensionFileOpeningInputSchema } from '../../../shared/extensions/extensionApi'
import { extensionManifestSchema } from '../../../shared/extensions/extensionManifest'
import { resolveFileOpening } from '../../../shared/files/fileOpening'
import { fileRange } from '../../filesystem/fileRange'
import { ExtensionPackageStore } from '../ExtensionPackageStore'
import { ExtensionService } from '../ExtensionService'
import { restoreExtensionBackup } from '../restoreExtensionBackup'
import { createStore, manifest, reviewPackage } from './fixtures'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
function fileManifest(id = 'tests.reader', version = '1.0.0') {
  return manifest({ id, version, apiVersion: 4, contributes: {
    views: [{ id: `${id}.view`, title: 'Reader', entry: 'view.js', resource: 'optional-file' }],
    fileHandlers: [{ id: `${id}.files`, title: 'Reader', extensions: ['.md', '.custom'], preview: { view: `${id}.view` }, open: { view: `${id}.view` } }],
    launchers: [{ id: `${id}.launch`, title: 'Reader', view: `${id}.view` }],
  } })
}
const choice = { extension: '.md', location: 'inline' as const, providerId: 'tests.reader.files' }
const target = { spaceId: 'space', directoryId: 'directory', revision: 4, path: 'document.md' }
const taskTarget = { conversationId: 'task', path: '/tasks/document #1%.custom' }
async function fixture() {
  const f = await createStore()
  cleanups.push(() => rm(f.root, { recursive: true, force: true }))
  return f
}
function contentResponse(text: string, request = new Request('https://resource.invalid/')) {
  const bytes = Buffer.from(text)
  const range = fileRange(bytes.length, request.headers.get('range'))
  return new Response(request.method === 'HEAD' || range.status === 416 ? null : bytes.subarray(range.start, range.end + 1), { status: range.status, headers: { ...range.headers, 'content-type': 'text/markdown' } })
}
async function serviceFixture(value = fileManifest(), overrides: Partial<ExtensionServicePorts> = {}) {
  const f = await fixture()
  await f.store.install((await reviewPackage(f.root, f.store, value)).token)
  let authorized = true
  const readers = new Map<string, NonNullable<Parameters<ExtensionServicePorts['createView']>[1]>>()
  const service = new ExtensionService(f.store, {
    createHost: () => ({ call: async () => null, dispose: async () => {}, devtools: () => {} }),
    createView: (_pkg, read) => {
      const token = randomUUID()
      if (read)
        readers.set(token, read)
      return { token, url: `lexora-extension://${token}/__view.html`, dispose: () => {
        readers.delete(token)
      } }
    },
    workbench: async () => randomUUID(),
    readText: async () => {
      if (!authorized)
        throw new Error('EXTENSION_RESOURCE_DENIED')
      return 'saved'
    },
    readResource: async (_target, _signal, request) => {
      if (!authorized)
        throw new Error('EXTENSION_RESOURCE_DENIED')
      return contentResponse('saved', request)
    },
    readArtifactResource: async (artifactId, _signal, request) => {
      if (!authorized || artifactId !== 'artifact')
        throw new Error('EXTENSION_RESOURCE_DENIED')
      return { name: 'output.md', response: contentResponse('artifact text', request) }
    },
    readTaskFileResource: async (target, _signal, request) => {
      if (!authorized || target.conversationId !== taskTarget.conversationId || target.path !== taskTarget.path)
        throw new Error('EXTENSION_RESOURCE_DENIED')
      return { name: 'document #1%.custom', response: contentResponse('task file text', request) }
    },
    get: async () => new Response(''),
    ...overrides,
  })
  cleanups.push(() => service.dispose())
  return { ...f, service, readers, revoke: () => {
    authorized = false
  } }
}
async function open(service: ExtensionService, prepared: Awaited<ReturnType<ExtensionService['prepareFileOpening']>>, viewId: string = randomUUID()) {
  return service.openView({ ...prepared, viewId, state: {}, stateVersion: 1 })
}
function call(service: ExtensionService, view: Awaited<ReturnType<typeof open>>, method: string, params: unknown) {
  return service.viewRequest(view.id, view.generation, view.token, method, params)
}

it('guards API 4 declarations, exact suffixes, ownership and file permissions while retaining API 1–4', () => {
  for (const apiVersion of [1, 2, 3, 4] as const)
    expect(extensionManifestSchema.parse(manifest({ apiVersion })).apiVersion).toBe(apiVersion)
  const value = fileManifest()
  expect(extensionManifestSchema.safeParse({ ...value, apiVersion: 3 }).success).toBe(false)
  expect(extensionManifestSchema.safeParse({ ...value, permissions: {} }).success).toBe(false)
  for (const extensions of [['*'], ['md'], ['.MD'], ['.md', '.md']]) {
    expect(extensionManifestSchema.safeParse({ ...value, contributes: { ...value.contributes, fileHandlers: [{ ...value.contributes.fileHandlers[0], extensions }] } }).success).toBe(false)
  }
  expect(extensionManifestSchema.safeParse({ ...value, contributes: { ...value.contributes, launchers: [{ id: 'other.plugin.launch', title: 'Foreign', view: value.contributes.views[0]!.id }] } }).success).toBe(false)
  expect(extensionManifestSchema.safeParse({ ...value, contributes: { ...value.contributes, views: [{ ...value.contributes.views[0], resource: 'selected-file' }] } }).success).toBe(false)
  for (const requestDefault of ['false', 0, null]) {
    expect(extensionManifestSchema.safeParse({
      ...value,
      contributes: { ...value.contributes, fileHandlers: [{ ...value.contributes.fileHandlers[0], preview: { view: 'tests.reader.view', requestDefault }, open: { view: 'tests.reader.view', requestDefault } }] },
    }).success).toBe(false)
  }
})

it('registers without taking defaults and only accepts reviewed choices from the reviewed manifest', async () => {
  const { root, store } = await fixture()
  const review = await reviewPackage(root, store, fileManifest())
  expect(review.fileAssociations).toContainEqual({ ...choice, title: 'Reader', currentProviderId: 'lexora.markdown', requestDefault: true })
  await store.install(review.token)
  expect(store.fileOpeners().providers.find(provider => provider.id === choice.providerId)).toMatchObject({ extensionId: 'tests.reader', extensionName: fileManifest().name, builtin: false })
  expect(resolveFileOpening(store.fileOpeners(), 'document.md', 'inline').provider?.id).toBe('lexora.markdown')
  for (const invalid of [{ ...choice, providerId: 'other.plugin.files' }, { ...choice, extension: '.txt' }, { ...choice, providerId: null }]) {
    const update = await reviewPackage(root, store, fileManifest('tests.reader', '1.1.0'))
    await expect(store.install(update.token, undefined, [invalid])).rejects.toThrow('EXTENSION_FILE_ASSOCIATION_DENIED')
  }
  expect(store.installed['tests.reader']!.pending).toBeNull()
})

it('persists independent location preferences, retaining unavailable choices after disable and uninstall', async () => {
  const { root, store } = await fixture()
  await store.install((await reviewPackage(root, store, fileManifest())).token, undefined, [choice])
  await store.install((await reviewPackage(root, store, fileManifest('tests.other'))).token)
  expect(resolveFileOpening(store.fileOpeners(), 'document.md', 'inline').provider?.id).toBe(choice.providerId)
  expect(resolveFileOpening(store.fileOpeners(), 'document.md', 'standalone').provider?.id).toBe('lexora.markdown')
  await store.enable('tests.reader', false)
  expect(resolveFileOpening(store.fileOpeners(), 'document.md', 'inline')).toMatchObject({ preferredId: choice.providerId, unavailable: true, provider: { id: 'lexora.markdown' } })
  await store.removeData('tests.reader')
  await store.uninstall('tests.reader')
  const review = await reviewPackage(root, store, fileManifest())
  expect(review.fileAssociations.find(item => item.extension === '.md' && item.location === 'inline')).toMatchObject({ currentProviderId: choice.providerId })
  store.cancelReview(review.token)
  const reloaded = new ExtensionPackageStore(store.root, store.appVersion)
  await reloaded.load()
  expect(reloaded.fileOpeners().defaults['.md']?.inline).toBe(choice.providerId)
  expect(resolveFileOpening(reloaded.fileOpeners(), 'document.md', 'inline').provider?.id).toBe('lexora.markdown')
  await reloaded.setFileOpener({ ...choice, providerId: null })
  expect(reloaded.fileOpeners().defaults['.md']).toBeUndefined()
})

it('defers reviewed defaults until promotion and protects all subsequent user changes including resets', async () => {
  const { root, store } = await fixture()
  await store.install((await reviewPackage(root, store, fileManifest())).token)
  const update = await reviewPackage(root, store, fileManifest('tests.reader', '1.1.0'))
  await store.install(update.token, undefined, [choice, { ...choice, location: 'standalone' }])
  expect(store.fileOpeners().defaults).toEqual({})
  await store.setFileOpener({ ...choice, providerId: 'lexora.text' })
  await store.setFileOpener({ ...choice, providerId: null })
  const reloaded = new ExtensionPackageStore(store.root, store.appVersion)
  await reloaded.load()
  await reloaded.promote('tests.reader')
  expect(reloaded.fileOpeners().defaults).toEqual({ '.md': { standalone: choice.providerId } })
  await reloaded.setFileOpener({ ...choice, providerId: 'lexora.text' })
  const ordinary = await reviewPackage(root, reloaded, fileManifest('tests.reader', '1.2.0'))
  await reloaded.install(ordinary.token)
  await reloaded.promote('tests.reader')
  expect(reloaded.fileOpeners().defaults['.md']?.inline).toBe('lexora.text')
})

it('does not overwrite a preference changed while initial installation was under review', async () => {
  const { root, store } = await fixture()
  const review = await reviewPackage(root, store, fileManifest())
  await store.setFileOpener({ ...choice, providerId: 'lexora.text' })
  await store.install(review.token, undefined, [choice])
  expect(store.fileOpeners().defaults['.md']?.inline).toBe('lexora.text')
})

it('carries path-free defaults in backup restore, retaining unrelated entries and revoking restored grants', async () => {
  const { root, store } = await fixture()
  await store.install((await reviewPackage(root, store, fileManifest())).token, undefined, [choice])
  await store.grant('tests.reader', target)
  const candidate = join(root, 'restored')
  await cp(store.root, candidate, { recursive: true })
  await restoreExtensionBackup(store.root, candidate)
  const restored = new ExtensionPackageStore(candidate, store.appVersion)
  await restored.load()
  expect(restored.fileOpeners().defaults).toEqual({ '.md': { inline: choice.providerId } })
  expect(restored.installed['tests.reader']!.enabled).toBe(false)
  await expect(readdir(join(candidate, 'data/tests.reader/resources'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readFile(join(candidate, 'installed.json'), 'utf8')).not.toContain(root)
})

it('prepares only declared file suffixes and standalone launchers without executing workbench UI', async () => {
  const { service } = await serviceFixture()
  expect(await service.prepareFileOpening({ providerId: 'tests.reader.launch', location: 'standalone', source: null })).toEqual({ extensionId: 'tests.reader', viewType: 'tests.reader.view', resource: null })
  await expect(service.prepareFileOpening({ providerId: choice.providerId, location: 'standalone', source: null })).rejects.toThrow('EXTENSION_FILE_OPENER_UNAVAILABLE')
  await expect(service.prepareFileOpening({ providerId: choice.providerId, location: 'inline', source: { kind: 'space', target: { ...target, path: 'file.txt' } } })).rejects.toThrow('EXTENSION_FILE_ASSOCIATION_DENIED')
  const prepared = await service.prepareFileOpening({ providerId: choice.providerId, location: 'standalone', source: { kind: 'space', target } })
  expect(prepared.resource).toEqual({ id: expect.any(String), name: 'document.md' })
  await service.enable('tests.reader', false)
  await expect(service.prepareFileOpening({ providerId: 'tests.reader.launch', location: 'standalone', source: null })).rejects.toThrow()
  expect((await service.fileOpeners()).providers.find(provider => provider.id === choice.providerId)?.available).toBe(false)
})

it('keeps inline text in bounded memory, expires replaced snapshots and rechecks authorization on reads', async () => {
  const { store, service, readers, revoke } = await serviceFixture()
  const input = { providerId: choice.providerId, location: 'inline' as const, source: { kind: 'space' as const, target }, text: 'unsaved preview' }
  const first = await service.prepareFileOpening(input)
  const view = await open(service, first)
  expect(await call(service, view, 'resources.readText', { id: first.resource!.id })).toBe(input.text)
  const preview = await readers.get(view.token)!(first.resource!.id, new Request('https://resource.invalid/'), new AbortController().signal)
  expect(preview.headers.get('access-control-allow-origin')).toBe('*')
  expect(preview.headers.get('content-type')).toBe('text/markdown')
  expect(await preview.text()).toBe(input.text)
  expect(await call(service, view, 'resources.readBytes', { id: first.resource!.id, offset: 0, length: 7 })).toMatchObject({ base64: Buffer.from('unsaved').toString('base64'), size: 15, eof: false })
  await expect(readdir(join(store.root, 'data/tests.reader/resources'))).rejects.toMatchObject({ code: 'ENOENT' })
  const second = await service.prepareFileOpening({ ...input, text: 'new snapshot' })
  const current = await open(service, second, view.id)
  await expect(open(service, first)).rejects.toThrow('EXTENSION_RESOURCE_DENIED')
  expect(await call(service, current, 'resources.readText', { id: second.resource!.id })).toBe('new snapshot')
  revoke()
  await expect(call(service, current, 'resources.readText', { id: second.resource!.id })).rejects.toThrow('EXTENSION_RESOURCE_DENIED')
  await expect(service.prepareFileOpening(input)).rejects.toThrow('EXTENSION_RESOURCE_DENIED')
})

it('validates the selected opener independently of more specific suffixes registered by another plugin', async () => {
  const { root, store, service } = await serviceFixture()
  const other = fileManifest('tests.compound')
  other.contributes.fileHandlers[0]!.extensions = ['.special.md']
  delete other.contributes.fileHandlers[0]!.preview
  await store.install((await reviewPackage(root, store, other)).token)
  const input = { providerId: choice.providerId, location: 'inline' as const, source: { kind: 'space' as const, target: { ...target, path: 'document.special.md' } } }
  const prepared = await service.prepareFileOpening(input)
  expect(prepared.resource).toMatchObject({ name: 'document.special.md' })
  await service.setFileOpener({ extension: '.special.md', location: 'inline', providerId: 'lexora.markdown' })
  expect(resolveFileOpening(await service.fileOpeners(), input.source.target.path, 'inline')).toMatchObject({ preferredId: 'lexora.markdown', unavailable: false, provider: { id: 'lexora.markdown' } })
  await expect(service.setFileOpener({ extension: '.unregistered.md', location: 'inline', providerId: 'lexora.markdown' })).rejects.toThrow('EXTENSION_FILE_ASSOCIATION_DENIED')
  await expect(service.setFileOpener({ extension: '.special.md', location: 'inline', providerId: 'lexora.media' })).rejects.toThrow('EXTENSION_FILE_ASSOCIATION_DENIED')
  await service.enable('tests.compound', false)
  const standalone = await service.prepareFileOpening({ ...input, location: 'standalone' })
  expect(await call(service, await open(service, standalone), 'resources.readText', { id: standalone.resource!.id })).toBe('saved')
})

it.each([
  { source: { kind: 'artifact' as const, artifactId: 'artifact' }, content: 'artifact text' },
  { source: { kind: 'task' as const, target: taskTarget }, content: 'task file text' },
])('binds $source.kind handles and resource URLs to the original source, current permission and owning view', async ({ source, content }) => {
  const { service, readers, revoke } = await serviceFixture()
  const prepared = await service.prepareFileOpening({ providerId: choice.providerId, location: 'standalone', source })
  const view = await open(service, prepared)
  const id = prepared.resource!.id
  expect(await call(service, view, 'resources.readText', { id })).toBe(content)
  expect(await call(service, view, 'resources.readBytes', { id, offset: 1, length: 4 })).toEqual({ base64: Buffer.from(content.slice(1, 5)).toString('base64'), size: content.length, eof: false })
  const url = await call(service, view, 'resources.getUrl', { id }) as string
  expect(url).toBe(`lexora-extension://${view.token}/__selected/${id}`)
  const reader = readers.get(view.token)!
  expect(await (await reader(id, new Request(url), new AbortController().signal)).text()).toBe(content)
  const other = await open(service, { extensionId: 'tests.reader', viewType: 'tests.reader.view', resource: null })
  await expect(call(service, other, 'resources.readText', { id })).rejects.toThrow('EXTENSION_RESOURCE_DENIED')
  await expect(readers.get(other.token)!(id, new Request(url), new AbortController().signal)).rejects.toThrow('EXTENSION_RESOURCE_DENIED')
  revoke()
  await expect(call(service, view, 'resources.readText', { id })).rejects.toThrow('EXTENSION_RESOURCE_DENIED')
  await expect(call(service, view, 'resources.getUrl', { id })).rejects.toThrow('EXTENSION_RESOURCE_DENIED')
  await expect(call(service, view, 'resources.readBytes', { id, offset: 0, length: 4 })).rejects.toThrow('EXTENSION_RESOURCE_DENIED')
  await expect(reader(id, new Request(url), new AbortController().signal)).rejects.toThrow('EXTENSION_RESOURCE_DENIED')
})

it('requires a prepared task handle and preserves source identity alongside legacy persisted grants', async () => {
  const { store, service } = await serviceFixture()
  const input = { providerId: choice.providerId, location: 'standalone' as const, source: { kind: 'task' as const, target: taskTarget } }
  await expect(open(service, { extensionId: 'tests.reader', viewType: 'tests.reader.view', resource: { id: randomUUID(), name: 'document #1%.custom' } })).rejects.toThrow('EXTENSION_RESOURCE_DENIED')
  for (const target of [{ ...taskTarget, conversationId: 'other-task' }, { ...taskTarget, path: '/tasks/missing.custom' }])
    await expect(service.prepareFileOpening({ ...input, source: { kind: 'task', target } })).rejects.toThrow('EXTENSION_RESOURCE_DENIED')
  expect(extensionFileOpeningInputSchema.safeParse({ ...input, source: { kind: 'task', target: { ...taskTarget, path: 'document.custom' } } }).success).toBe(false)
  const legacy = await store.grant('tests.reader', target)
  const legacyPath = join(store.root, 'data/tests.reader/resources', `${legacy.id}.json`)
  const legacyContent = await readFile(legacyPath, 'utf8')
  const prepared = await service.prepareFileOpening(input)
  expect(prepared.resource).toEqual({ id: expect.any(String), name: 'document #1%.custom' })
  const reloaded = new ExtensionPackageStore(store.root, store.appVersion)
  await reloaded.load()
  expect(await reloaded.resolveFileOpeningGrant('tests.reader', prepared.resource!.id)).toEqual(input.source)
  expect(await reloaded.resolveFileOpeningGrant('tests.reader', legacy.id)).toEqual({ kind: 'space', target })
  expect(await readFile(legacyPath, 'utf8')).toBe(legacyContent)
  await expect(reloaded.resolveFileOpeningGrant('tests.other', prepared.resource!.id)).rejects.toThrow('EXTENSION_RESOURCE_DENIED')
  const view = await open(service, prepared)
  await store.revokeFileOpeningGrants('tests.reader')
  await expect(call(service, view, 'resources.readText', { id: prepared.resource!.id })).rejects.toThrow('EXTENSION_RESOURCE_DENIED')
})

it('rejects task sources without a reader and enforces the selected provider suffix', async () => {
  const input = { providerId: choice.providerId, location: 'inline' as const, source: { kind: 'task' as const, target: taskTarget } }
  const unavailable = await serviceFixture(fileManifest(), { readTaskFileResource: undefined })
  await expect(unavailable.service.prepareFileOpening(input)).rejects.toThrow('EXTENSION_RESOURCE_UNAVAILABLE')
  const unsupported = await serviceFixture(fileManifest(), { readTaskFileResource: async () => ({ name: 'document.txt', response: contentResponse('text') }) })
  await expect(unsupported.service.prepareFileOpening(input)).rejects.toThrow('EXTENSION_FILE_ASSOCIATION_DENIED')
})

it.each(['prepare', 'read'] as const)('rejects a late task %s when the owning plugin version changes', async (operation) => {
  const pending = deferred<{ name: string, response: Response }>()
  const started = deferred<void>()
  let wait = false
  const { root, store, service, readers } = await serviceFixture(fileManifest(), { readTaskFileResource: async (_target, _signal, request) => {
    if (!wait)
      return { name: 'document.custom', response: contentResponse('task file text', request) }
    started.resolve()
    return pending.promise
  } })
  const input = { providerId: choice.providerId, location: 'standalone' as const, source: { kind: 'task' as const, target: taskTarget } }
  const prepared = await service.prepareFileOpening(input)
  const view = await open(service, prepared)
  const reader = readers.get(view.token)!
  const update = await reviewPackage(root, store, fileManifest('tests.reader', '1.1.0'))
  await service.install(update.token)
  wait = true
  const reading = operation === 'prepare'
    ? service.prepareFileOpening(input)
    : call(service, view, 'resources.readText', { id: prepared.resource!.id })
  const rejected = expect(reading).rejects.toThrow('EXTENSION_HOST_STOPPED')
  await started.promise
  await service.applyUpdate('tests.reader')
  pending.resolve({ name: 'document.custom', response: contentResponse('late task file text') })
  await rejected
  await expect(reader(prepared.resource!.id, new Request('https://resource.invalid/'), new AbortController().signal)).rejects.toThrow('EXTENSION_RESOURCE_DENIED')
  await expect(call(service, view, 'resources.readText', { id: prepared.resource!.id })).rejects.toThrow('EXTENSION_VIEW_EXPIRED')
  wait = false
  const current = await open(service, await service.prepareFileOpening(input))
  expect(current.generation).not.toBe(view.generation)
})

it('revokes persisted and transient selected handles without changing defaults or original files', async () => {
  const { service, store } = await serviceFixture()
  await service.setFileOpener(choice)
  const source = { kind: 'space' as const, target }
  const saved = await service.prepareFileOpening({ providerId: choice.providerId, location: 'standalone', source })
  const draft = await service.prepareFileOpening({ providerId: choice.providerId, location: 'inline', source, text: 'draft' })
  await open(service, draft)
  await service.revokeResources('tests.reader')
  await expect(open(service, saved)).rejects.toThrow('EXTENSION_RESOURCE_DENIED')
  await expect(open(service, draft)).rejects.toThrow('EXTENSION_RESOURCE_DENIED')
  expect(store.fileOpeners().defaults['.md']?.inline).toBe(choice.providerId)
})

it('rejects snapshots for standalone, absent and artifact sources and bounds UTF-8 snapshot bytes', async () => {
  const { service } = await serviceFixture()
  const input = { providerId: choice.providerId, location: 'inline' as const, source: { kind: 'space' as const, target }, text: 'draft' }
  expect(extensionFileOpeningInputSchema.safeParse({ ...input, location: 'standalone' }).success).toBe(false)
  expect(extensionFileOpeningInputSchema.safeParse({ ...input, source: null }).success).toBe(false)
  expect(extensionFileOpeningInputSchema.safeParse({ ...input, source: { kind: 'artifact', artifactId: 'artifact' } }).success).toBe(false)
  await expect(service.prepareFileOpening({ ...input, text: '文'.repeat(750000) })).rejects.toThrow('EXTENSION_RESOURCE_TEXT_LIMIT')
  const prepared = await service.prepareFileOpening(input)
  const view = await open(service, prepared)
  service.closeView(view.id, view.generation, view.token)
  await expect(open(service, prepared)).rejects.toThrow('EXTENSION_RESOURCE_DENIED')
})

function legacyManifest() {
  const value = fileManifest()
  const { fileHandlers: _, ...contributes } = value.contributes
  return { ...value, contributes: { ...contributes, fileOpeners: [{ id: choice.providerId, title: 'Reader', extensions: ['.md', '.custom'], view: 'tests.reader.view', locations: ['inline', 'standalone'], requestDefault: false }] } }
}

it('normalizes legacy declarations, preserves package bytes and upgrades existing defaults through pending promotion', async () => {
  const { root, store } = await fixture()
  const legacy = legacyManifest()
  const raw = JSON.stringify(legacy)
  const files = new Map(Object.entries({ 'extension.json': raw, 'extension.js': 'export function activate() {}', 'view.js': 'export function render() {}' }).map(([name, value]) => [name, Buffer.from(value)]))
  const review = await store.reviewFiles(files)
  expect(review.fileAssociations.every(item => !item.requestDefault)).toBe(true)
  await store.install(review.token, undefined, [choice, { ...choice, location: 'standalone' }])
  const original = store.installed['tests.reader']!.current
  const indexPath = join(store.root, 'installed.json')
  const index = JSON.parse(await readFile(indexPath, 'utf8'))
  index.installed['tests.reader'].current.manifest = legacy
  await writeFile(indexPath, JSON.stringify(index))
  const reloaded = new ExtensionPackageStore(store.root, store.appVersion)
  await reloaded.load()
  expect(reloaded.installed['tests.reader']!.current.manifest.contributes.fileHandlers[0]).toMatchObject({ preview: { view: 'tests.reader.view', requestDefault: false }, open: { view: 'tests.reader.view', requestDefault: false } })
  expect(await readFile(join(store.packageRoot(original), 'extension.json'), 'utf8')).toBe(raw)
  expect(reloaded.installed['tests.reader']!.current.hashes).toEqual(original.hashes)
  const updated = fileManifest('tests.reader', '1.1.0')
  updated.contributes.views.push({ ...updated.contributes.views[0]!, id: 'tests.reader.preview', resource: 'selected-file' })
  updated.contributes.fileHandlers[0]!.preview!.view = 'tests.reader.preview'
  await reloaded.install((await reviewPackage(root, reloaded, updated)).token)
  const pending = new ExtensionPackageStore(store.root, store.appVersion)
  await pending.load()
  await pending.promote('tests.reader')
  expect(pending.fileOpeners().defaults['.md']).toEqual({ inline: choice.providerId, standalone: choice.providerId })
  expect(pending.installed['tests.reader']!.current.manifest.contributes.fileHandlers[0]!.preview!.view).toBe('tests.reader.preview')
  expect(JSON.parse(await readFile(indexPath, 'utf8')).fileOpeningRevisions).toEqual(index.fileOpeningRevisions)
})

it('validates both file-handler targets and rejects duplicate IDs across legacy and current declarations', () => {
  const value = fileManifest()
  for (const target of ['preview', 'open'] as const) {
    for (const view of ['other.plugin.view', 'tests.reader.missing']) {
      const handler = { ...value.contributes.fileHandlers[0], [target]: { view } }
      expect(extensionManifestSchema.safeParse({ ...value, contributes: { ...value.contributes, fileHandlers: [handler] } }).success).toBe(false)
    }
  }
  const { preview: _, open: __, ...empty } = value.contributes.fileHandlers[0]!
  expect(extensionManifestSchema.safeParse({ ...value, contributes: { ...value.contributes, fileHandlers: [empty] } }).success).toBe(false)
  expect(extensionManifestSchema.safeParse({ ...value, contributes: { ...value.contributes, fileOpeners: legacyManifest().contributes.fileOpeners } }).success).toBe(false)
})

it.each(['preview', 'open'] as const)('routes a %s-only handler without a launcher and refuses the undeclared location', async (mode) => {
  const value = fileManifest()
  const handler = value.contributes.fileHandlers[0]!
  delete handler[mode === 'preview' ? 'open' : 'preview']
  value.contributes.launchers = []
  const { service } = await serviceFixture(value)
  const location = mode === 'preview' ? 'inline' : 'standalone'
  expect((await service.fileOpeners()).providers.find(item => item.id === choice.providerId)?.locations).toEqual([location])
  const prepared = await service.prepareFileOpening({ providerId: choice.providerId, location, source: { kind: 'space', target } })
  expect(prepared.viewType).toBe('tests.reader.view')
  expect(await call(service, await open(service, prepared), 'resources.readText', { id: prepared.resource!.id })).toBe('saved')
  await expect(service.prepareFileOpening({ providerId: choice.providerId, location: mode === 'preview' ? 'standalone' : 'inline', source: { kind: 'space', target } })).rejects.toThrow('EXTENSION_FILE_OPENER_UNAVAILABLE')
  await expect(service.prepareFileOpening({ providerId: 'tests.reader.launch', location: 'standalone', source: null })).rejects.toThrow('EXTENSION_FILE_OPENER_UNAVAILABLE')
})

it('selects distinct preview and open views with independent default requests under one provider ID', async () => {
  const value = fileManifest()
  value.contributes.views.push({ ...value.contributes.views[0]!, id: 'tests.reader.preview', resource: 'selected-file' })
  value.contributes.fileHandlers[0]!.preview = { view: 'tests.reader.preview', requestDefault: false }
  const { root, store, service } = await serviceFixture(value)
  const review = await reviewPackage(root, store, { ...value, version: '1.1.0' })
  expect(review.fileAssociations.filter(item => item.extension === '.md')).toMatchObject([
    { location: 'inline', providerId: choice.providerId, requestDefault: false },
    { location: 'standalone', providerId: choice.providerId, requestDefault: true },
  ])
  for (const location of ['inline', 'standalone'] as const) {
    const prepared = await service.prepareFileOpening({ providerId: choice.providerId, location, source: { kind: 'space', target } })
    expect(prepared.viewType).toBe(location === 'inline' ? 'tests.reader.preview' : 'tests.reader.view')
    expect(await call(service, await open(service, prepared), 'resources.readText', { id: prepared.resource!.id })).toBe('saved')
  }
})
