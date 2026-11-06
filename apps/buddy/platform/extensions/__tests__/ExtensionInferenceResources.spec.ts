import type { InferencePrepare, InferenceResourceProgress, InferenceResourceSet } from '../../../shared/extensions/extensionInference'
import type { InferenceResourceSource } from '../ExtensionInferenceResources'
import { createHash } from 'node:crypto'
import { link, mkdir, open, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { deferred } from '@buddy-tests/deferred'
import { createTemporaryDirectory } from '@buddy-tests/temporaryDirectories'
import { expect, it, onTestFinished, vi } from 'vitest'
import { inferenceResourceFileSchema } from '../../../shared/extensions/extensionInference'
import { backupDirectoryAllowed } from '../../../shared/storage/backupScope'
import { resolveBuddyPrivateDirectories } from '../../native/nativeHost'
import { copyStorageTree, measureStorage } from '../../storage/storageTree'
import { ExtensionInferenceResources } from '../ExtensionInferenceResources'
import { ExtensionResourceStore } from '../ExtensionResourceStore'

const owner = 'tests.inference'
function current() {}
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const signal = () => new AbortController().signal
function plan(text = 'weights'): InferencePrepare {
  return {
    id: 'model',
    kind: 'model',
    files: [{ path: 'model.bin', sha256: hash(text), source: { url: 'https://fixture.invalid/model' } }],
  }
}

async function fixture() {
  const root = await createTemporaryDirectory('lexora-inference-resources-')
  const resources = new ExtensionResourceStore(root)
  const store = new ExtensionInferenceResources(root)
  const source: InferenceResourceSource = {
    response: async () => new Response('weights'),
    openReference: id => resources.openReference(owner, id),
    openDirectoryReference: input => resources.openDirectoryReference(owner, input),
    referencePath: id => resources.referencePath(owner, id),
    directoryReferencePath: input => resources.directoryReferencePath(owner, input),
  }
  onTestFinished(() => store.drain())
  return {
    root,
    store,
    resources,
    source,
    files: join(root, 'inference', owner, 'files'),
    prepare: () => store.prepare(owner, plan(), source, signal(), current),
  }
}

async function contents(store: ExtensionInferenceResources, resource: InferenceResourceSet, source: InferenceResourceSource) {
  const lease = await store.acquire(owner, resource, source, signal())
  try {
    return await lease.files[0]!.handle.readFile('utf8')
  }
  finally {
    await lease.release()
  }
}

it.each(['link', 'unlink'] as const)('verifies content while another runtime changes a resource hardlink with %s', async (operation) => {
  const { root, store, resources, source } = await fixture()
  const original = join(root, 'shared-model.bin')
  const mapped = join(root, 'other-runtime-model.bin')
  await writeFile(original, 'weights')
  const [grant] = await resources.grant(owner, [original], current)
  const prepared = await store.prepare(owner, {
    ...plan(),
    files: [{ path: 'model.bin', sha256: hash('weights'), source: { resourceId: grant!.id, reference: true } }],
  }, source, signal(), current)
  if (operation === 'unlink')
    await link(original, mapped)
  const lease = await store.acquire(owner, prepared, {
    ...source,
    openReference: async (id) => {
      const handle = await resources.openReference(owner, id)
      const read = handle.read.bind(handle)
      vi.spyOn(handle, 'read').mockImplementationOnce(async (...args: Parameters<typeof read>) => {
        const result = await read(...args)
        if (operation === 'link')
          await link(original, mapped)
        else
          await rm(mapped)
        return result
      })
      return handle
    },
  }, signal())
  try {
    expect(await lease.files[0]!.handle.readFile('utf8')).toBe('weights')
  }
  finally {
    await lease.release()
  }
  const writer = await open(original, 'r+')
  try {
    await writer.write('changed', 0)
  }
  finally {
    await writer.close()
  }
  await expect(store.acquire(owner, prepared, source, signal())).rejects.toThrow('EXTENSION_INFERENCE_RESOURCE_CHANGED')
})

it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1])('rejects invalid file size %s', (size) => {
  expect(inferenceResourceFileSchema.safeParse({ ...plan().files[0], size }).success).toBe(false)
})

it.each([undefined, 7])('reports connection, received chunks and final EOF with chunked size %s', async (size) => {
  const { store, source } = await fixture()
  const response = deferred<Response>()
  const requested = deferred<void>()
  const progress: InferenceResourceProgress[] = []
  let now = Date.now()
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
  onTestFinished(() => clock.mockRestore())
  let stream!: ReadableStreamDefaultController<Uint8Array>
  const body = new ReadableStream<Uint8Array>({
    start(controller) { stream = controller },
  })
  const input = plan()
  input.files[0]!.size = size
  const pending = store.prepare(owner, input, { ...source, response: async () => {
    requested.resolve()
    return response.promise
  } }, signal(), current, value => progress.push(value))
  await requested.promise
  expect(progress).toEqual([{ resource: 'model', path: 'model.bin', phase: 'connect', bytes: 0, totalBytes: size ?? null, completedFiles: 0, totalFiles: 1, resumedBytes: 0 }])
  response.resolve(new Response(body))
  await vi.waitFor(() => expect(progress.at(-1)?.phase).toBe('download'))
  for (const [chunk, bytes] of [['wei', 3], ['gh', 5]] as const) {
    now += 201
    stream.enqueue(new TextEncoder().encode(chunk))
    await vi.waitFor(() => expect(progress.at(-1)?.bytes).toBe(bytes))
  }
  stream.enqueue(new TextEncoder().encode('ts'))
  stream.close()
  const result = await pending
  const downloads = progress.filter(value => value.phase === 'download')
  expect([...new Set(downloads.map(value => value.bytes))]).toEqual([0, 3, 5, 7])
  expect(downloads.at(-1)?.bytes).toBe(7)
  expect(downloads.every(value => value.totalBytes === (size ?? null))).toBe(true)
  expect(progress.find(value => value.phase === 'verify')).toMatchObject({ path: 'model.bin', bytes: 7, completedFiles: 0 })
  expect(progress.at(-1)).toEqual({ resource: 'model', path: '', phase: 'ready', bytes: 7, totalBytes: 7, completedFiles: 1, totalFiles: 1 })
  expect(await contents(store, result, source)).toBe('weights')
})

it('reports each verified file before advancing and commits one ready event including empty files', async () => {
  const { store, source } = await fixture()
  const progress: InferenceResourceProgress[] = []
  await store.prepare(owner, { ...plan(), files: [
    { ...plan().files[0]!, size: 7 },
    { path: 'empty.bin', sha256: hash(''), size: 0, source: { url: 'https://fixture.invalid/empty' } },
  ] }, { ...source, response: async from => new Response('url' in from && from.url.endsWith('/empty') ? '' : 'weights') }, signal(), current, value => progress.push(value))
  expect(progress.filter(value => value.phase === 'connect').map(value => [value.path, value.totalBytes, value.completedFiles, value.totalFiles])).toEqual([
    ['model.bin', 7, 0, 2],
    ['empty.bin', 0, 1, 2],
  ])
  expect(progress.filter(value => value.phase === 'verify' && value.completedFiles > 0)).toEqual(expect.arrayContaining([
    expect.objectContaining({ path: 'model.bin', bytes: 7, completedFiles: 1 }),
    expect.objectContaining({ path: 'empty.bin', bytes: 0, completedFiles: 2 }),
  ]))
  expect(progress.filter(value => value.phase === 'ready')).toEqual([{ resource: 'model', path: '', phase: 'ready', bytes: 7, totalBytes: 7, completedFiles: 2, totalFiles: 2 }])
})

it('separates preparation input downloads from verified output counts and final collection bytes', async () => {
  const { store, source } = await fixture()
  const progress: InferenceResourceProgress[] = []
  const result = await store.prepare(owner, {
    id: 'model',
    kind: 'model',
    files: [],
    preparation: {
      inputs: [{ id: 'bundle', sha256: hash('weights'), size: 7, source: { url: 'https://fixture.invalid/bundle' } }],
      options: {},
      maxBytes: 100,
      maxFiles: 3,
    },
  }, { ...source, prepare: async (_inputs, _options, signal, event) => {
    const empty = new Uint8Array()
    await event({ type: 'file', path: 'model.bin', size: 7 }, empty, signal)
    await event({ type: 'chunk' }, new TextEncoder().encode('weights'), signal)
    await event({ type: 'end', sha256: hash('weights') }, empty, signal)
    await event({ type: 'file', path: 'empty.bin', size: 0 }, empty, signal)
    await event({ type: 'end', sha256: hash('') }, empty, signal)
    await event({ type: 'alias', path: 'copy.bin', target: 'model.bin' }, empty, signal)
  } }, signal(), current, value => progress.push(value))
  expect(progress.filter(value => value.phase === 'download').at(-1)).toMatchObject({ path: 'bundle', bytes: 7, totalBytes: 7, completedFiles: 0, totalFiles: 0 })
  const extract = progress.filter(value => value.phase === 'extract')
  expect(extract.filter(value => value.completedFiles > 0)).toEqual(expect.arrayContaining([
    expect.objectContaining({ path: 'model.bin', completedFiles: 1, bytes: 7 }),
    expect.objectContaining({ path: 'empty.bin', completedFiles: 2, bytes: 0 }),
    expect.objectContaining({ path: 'copy.bin', completedFiles: 3, bytes: 7 }),
  ]))
  expect(extract.every(value => value.totalFiles === 0)).toBe(true)
  expect(progress.at(-1)).toMatchObject({ phase: 'ready', path: '', bytes: 14, totalBytes: 14, completedFiles: 3, totalFiles: 3 })
  expect(result).toMatchObject({ files: 3, bytes: 14 })
})

it.each(['cancel', 'failure'] as const)('ends %s during connection without claiming received bytes or publishing a replacement', async (ending) => {
  const { store, source, files, prepare } = await fixture()
  const previous = await prepare()
  const response = deferred<Response>()
  const requested = deferred<void>()
  const abort = new AbortController()
  const progress: InferenceResourceProgress[] = []
  const pending = store.prepare(owner, plan('replacement'), { ...source, response: async () => {
    requested.resolve()
    return response.promise
  } }, abort.signal, current, value => progress.push(value))
  const rejected = expect(pending).rejects.toThrow(ending === 'cancel' ? 'TEST_CANCELLED' : 'DOWNLOAD_FAILED')
  await requested.promise
  if (ending === 'cancel')
    abort.abort(new Error('TEST_CANCELLED'))
  response.reject(ending === 'cancel' ? abort.signal.reason : new Error('connection refused'))
  await rejected
  expect(progress).toEqual([{ resource: 'model', path: 'model.bin', phase: 'connect', bytes: 0, totalBytes: null, completedFiles: 0, totalFiles: 1, resumedBytes: 0 }])
  expect(await store.list(owner)).toEqual([previous])
  expect(await readdir(files)).toEqual([hash('weights')])
})

it.each([0, 6, 8])('validates actual bytes against declared size %s without losing the previous revision', async (size) => {
  const { store, source, files, prepare } = await fixture()
  const previous = await prepare()
  const input = plan()
  input.files[0]!.size = size
  const progress: InferenceResourceProgress[] = []
  await expect(store.prepare(owner, input, source, signal(), current, value => progress.push(value))).rejects.toThrow('CHECKSUM_MISMATCH')
  expect(progress.some(value => value.phase === 'download')).toBe(false)
  expect(progress.some(value => value.phase === 'ready')).toBe(false)
  expect(await store.list(owner)).toEqual([previous])
  expect(await readdir(files)).toEqual([hash('weights')])
})

it('retains verified bytes and the previous revision after checksum, connection, permission and local read failures', async () => {
  const { store, source, files, prepare } = await fixture()
  const previous = await prepare()
  const failures: Array<{ response: InferenceResourceSource['response'], error: string, local?: boolean }> = [
    { response: async () => new Response('bad replacement'), error: 'CHECKSUM_MISMATCH' },
    {
      response: async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new TextEncoder().encode('partial')) },
        pull(controller) { controller.error(new Error('net::ERR_CONNECTION_CLOSED')) },
      })),
      error: 'DOWNLOAD_FAILED',
    },
    { response: async () => { throw new Error('EXTENSION_NETWORK_DENIED') }, error: 'EXTENSION_NETWORK_DENIED' },
    {
      response: async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.error(new Error('FILE_READ_FAILED')) },
      })),
      error: 'FILE_READ_FAILED',
      local: true,
    },
  ]
  for (const failure of failures) {
    const replacement = plan('replacement')
    if (failure.local)
      replacement.files[0]!.source = { resourceId: 'b089dcb5-4185-4010-aa68-c9ca789b335f', reference: false }
    await expect(store.prepare(owner, replacement, { ...source, response: failure.response }, signal(), current)).rejects.toThrow(failure.error)
    expect(await store.list(owner)).toEqual([previous])
    expect(await readdir(files)).toEqual([hash('weights')])
  }
  expect(await contents(store, previous, source)).toBe('weights')
})

it('keeps old revisions usable and refuses deletion while leased without exposing them to another plugin', async () => {
  const { store, source, files, prepare } = await fixture()
  const previous = await prepare()
  const replacement = await store.prepare(owner, plan('replacement'), { ...source, response: async () => new Response('replacement') }, signal(), current)
  expect(await store.list(owner)).toEqual([previous, replacement])
  const lease = await store.acquire(owner, previous, source, signal())
  try {
    expect(await lease.files[0]!.handle.readFile('utf8')).toBe('weights')
    await expect(store.remove(owner, previous, current)).rejects.toThrow('RESOURCE_BUSY')
    await expect(store.clear(owner)).rejects.toThrow('RESOURCE_BUSY')
    await expect(store.acquire('tests.other', previous, source, signal())).rejects.toThrow('RESOURCE_UNAVAILABLE')
  }
  finally {
    await lease.release()
  }
  await store.remove(owner, previous, current)
  expect(await store.list(owner)).toEqual([replacement])
  expect(await readdir(files)).toEqual([hash('replacement')])
  expect(await contents(store, replacement, source)).toBe('replacement')
  await store.clear(owner)
  expect(await store.list(owner)).toEqual([])
})

it('cancels a partially written replacement without publishing it or changing ready assets', async () => {
  const { store, source, files, prepare } = await fixture()
  const previous = await prepare()
  const abort = new AbortController()
  onTestFinished(() => abort.abort())
  const partial: InferenceResourceSource = {
    ...source,
    response: async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('partial')) },
    }), { headers: { 'content-length': '7' } }),
  }
  await expect(store.prepare(owner, plan('replacement'), partial, abort.signal, current, (progress) => {
    if (progress.phase === 'download' && progress.bytes > 0)
      abort.abort(new Error('Cancelled replacement'))
  })).rejects.toThrow('Cancelled replacement')
  expect(await store.list(owner)).toEqual([previous])
  expect(await readdir(files)).toEqual([hash('weights')])
  expect(await contents(store, previous, source)).toBe('weights')
})

it('classifies changed and missing file references and requires a new grant to recover', async () => {
  const { store, resources, source, root } = await fixture()
  const original = join(root, 'original.bin')
  await writeFile(original, 'weights')
  const prepareReference = async () => {
    const [grant] = await resources.grant(owner, [original], current)
    return store.prepare(owner, {
      ...plan(),
      files: [{ path: 'model.bin', sha256: hash('weights'), source: { resourceId: grant!.id, reference: true } }],
    }, source, signal(), current)
  }
  const previous = await prepareReference()
  await writeFile(original, 'damaged bytes')
  await expect(store.acquire(owner, previous, source, signal())).rejects.toThrow('EXTENSION_INFERENCE_RESOURCE_CHANGED')
  await rm(original)
  await expect(store.acquire(owner, previous, source, signal())).rejects.toThrow('EXTENSION_INFERENCE_RESOURCE_UNAVAILABLE')
  await writeFile(original, 'weights')
  await expect(store.acquire(owner, previous, source, signal())).rejects.toThrow('EXTENSION_INFERENCE_RESOURCE_CHANGED')
  const repaired = await prepareReference()
  expect(await contents(store, repaired, source)).toBe('weights')
  await store.clear(owner)
  expect(await readFile(original, 'utf8')).toBe('weights')
})

it('limits directory references to the owning grant and rejects traversal, symlinks and changed bytes', async () => {
  const { store, resources, source, root } = await fixture()
  const directory = join(root, 'engine')
  await mkdir(directory)
  await writeFile(join(directory, 'weights.bin'), 'weights')
  const grant = await resources.grantDirectory(owner, directory, current)
  const reference = { directoryId: grant.id, path: 'weights.bin' }
  const valid = await store.prepare(owner, {
    ...plan(),
    files: [{ path: 'model.bin', sha256: hash('weights'), source: { ...reference, reference: true } }],
  }, source, signal(), current)
  expect(await contents(store, valid, source)).toBe('weights')
  await expect(resources.openDirectoryReference('tests.other', reference)).rejects.toThrow('DIRECTORY_UNAVAILABLE')
  await expect(resources.openDirectoryReference(owner, { ...reference, path: '../outside.bin' })).rejects.toThrow()
  await writeFile(join(root, 'outside.bin'), 'weights')
  if (process.platform !== 'win32') {
    await symlink(join(root, 'outside.bin'), join(directory, 'alias.bin'))
    await expect(resources.openDirectoryReference(owner, { ...reference, path: 'alias.bin' })).rejects.toThrow('DIRECTORY_CHANGED')
  }
  await symlink(root, join(directory, 'outside'), process.platform === 'win32' ? 'junction' : 'dir')
  await expect(resources.openDirectoryReference(owner, { ...reference, path: 'outside/outside.bin' })).rejects.toThrow('DIRECTORY_CHANGED')
  await writeFile(join(directory, 'weights.bin'), 'changed')
  await expect(store.acquire(owner, valid, source, signal())).rejects.toThrow('CHECKSUM_MISMATCH')
  await writeFile(join(directory, 'weights.bin'), 'weights')
  await resources.revokeDirectory(owner, grant.id, current)
  await expect(store.acquire(owner, valid, source, signal())).rejects.toThrow('RESOURCE_UNAVAILABLE')
  await store.remove(owner, valid, current)
  expect(await readFile(join(directory, 'weights.bin'), 'utf8')).toBe('weights')
  expect(await readFile(join(root, 'outside.bin'), 'utf8')).toBe('weights')
})

it('retains revoked references for inspection, keeps owned resources available and never deletes original files', async () => {
  const { root, store, resources, source, prepare } = await fixture()
  const owned = await prepare()
  const original = join(root, 'external.bin')
  const directory = join(root, 'external-directory')
  await writeFile(original, 'weights')
  await mkdir(directory)
  await writeFile(join(directory, 'model.bin'), 'weights')
  const [fileGrant] = await resources.grant(owner, [original], current)
  const directoryGrant = await resources.grantDirectory(owner, directory, current)
  const references: InferenceResourceSet[] = []
  for (const [id, from] of [
    ['file', { resourceId: fileGrant!.id, reference: true }],
    ['directory', { directoryId: directoryGrant.id, path: 'model.bin', reference: true }],
  ] as const) {
    references.push(await store.prepare(owner, {
      id,
      kind: 'model',
      files: [{ path: 'model.bin', sha256: hash('weights'), source: from }],
    }, source, signal(), current))
  }
  await expect(resources.openReference('tests.other', fileGrant!.id)).rejects.toThrow('RESOURCE_UNAVAILABLE')
  const inspect = async () => store.inspect(owner, new Set((await resources.list(owner)).map(file => file.id)), new Set((await resources.directories(owner)).map(directory => directory.id)))
  expect((await inspect()).map(({ id, authorized }) => ({ id, authorized }))).toEqual([
    { id: owned.id, authorized: true },
    { id: 'file', authorized: true },
    { id: 'directory', authorized: true },
  ])
  await resources.revoke(owner)
  expect((await inspect()).map(({ id, authorized }) => ({ id, authorized }))).toEqual([
    { id: owned.id, authorized: true },
    { id: 'file', authorized: false },
    { id: 'directory', authorized: false },
  ])
  expect(await store.available(owner, new Set(), new Set())).toEqual([owned])
  expect(await contents(store, owned, source)).toBe('weights')
  for (const resource of references) {
    await expect(store.acquire(owner, resource, source, signal())).rejects.toThrow('RESOURCE_UNAVAILABLE')
    await store.remove(owner, resource, current)
  }
  await store.clear(owner)
  expect(await readFile(original, 'utf8')).toBe('weights')
  expect(await readFile(join(directory, 'model.bin'), 'utf8')).toBe('weights')
})

it('preserves owned model bytes during directory migration without treating them as cache or backup content', async () => {
  const { root, store, source, prepare } = await fixture()
  const valid = await prepare()
  const target = await createTemporaryDirectory('lexora-inference-moved-')
  const destination = join(target, 'buddy/extensions')
  const privateDirectoriesExecutable = resolveBuddyPrivateDirectories({ appPath: process.cwd(), resourcesPath: '', isPackaged: false })
  await copyStorageTree(root, destination, { signal: signal(), report() {}, privateDirectoriesExecutable })
  const copied = new ExtensionInferenceResources(destination)
  expect(await copied.list(owner)).toEqual([valid])
  expect(await contents(copied, valid, source)).toBe('weights')
  const usage = await measureStorage(target)
  expect(usage.categories.find(category => category.id === 'plugins')?.details.find(detail => detail.id === 'pluginData')?.bytes).toBeGreaterThan(7)
  expect(usage.categories.find(category => category.id === 'cache')?.bytes).toBe(0)
  expect(backupDirectoryAllowed('buddy/extensions/inference', ['plugins'])).toBe(false)
  await writeFile(join(destination, 'inference', owner, 'files', hash('weights')), 'changed')
  await expect(copied.acquire(owner, valid, source, signal())).rejects.toThrow('CHECKSUM_MISMATCH')
  expect(await contents(store, valid, source)).toBe('weights')
  await copied.drain()
})
