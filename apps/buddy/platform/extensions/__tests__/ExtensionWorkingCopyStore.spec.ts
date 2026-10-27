import type { ExtensionDocument, ExtensionDocumentWrite } from '../../../shared/extensions/extensionDocuments'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { LocalDocumentFileService } from '../../../service/src/files/LocalDocumentFileService'
import { NativeFileEngine } from '../../../service/src/files/NativeFileEngine'
import { FileAssetStore } from '../../filesystem/FileAssetStore'
import { ExtensionWorkingCopyStore } from '../ExtensionWorkingCopyStore'

const fixtures: { root: string, engine: NativeFileEngine }[] = []
const plugin = 'tests.documents'
function current() {}
const signal = new AbortController().signal
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'lexora-document-'))
  const home = join(root, 'home')
  await mkdir(home)
  const path = join(root, 'original.xlsx')
  await writeFile(path, Buffer.from([80, 75, 0, 255, 1]))
  const engine = new NativeFileEngine(join(home, 'operations'))
  fixtures.push({ root, engine })
  await engine.ready()
  const files = new LocalDocumentFileService(home, engine, async () => path)
  const ports = { commit: files.commit.bind(files), query: files.query.bind(files), resolve: async () => path, reveal: async () => {} }
  const store = new ExtensionWorkingCopyStore(join(home, 'extensions'), ports)
  return { root, home, path, engine, store, ports, document: await store.openPath(plugin, 'view', path, signal, current) }
}
async function upload(store: ExtensionWorkingCopyStore, document: ExtensionDocument, bytes: Uint8Array, mode: ExtensionDocumentWrite['mode'] = 'save', path: string | null = null) {
  const writer = await store.begin(plugin, 'view', { id: document.id, name: document.name, version: document.version, revision: document.revision, size: bytes.length, mode, operationId: randomUUID() }, path, signal, current)
  await writer.append(0, Buffer.from(bytes).toString('base64'))
  try {
    return await writer.commit()
  }
  finally {
    await writer.dispose()
  }
}
afterEach(async () => {
  for (const item of fixtures.splice(0)) {
    await item.engine.dispose()
    await rm(item.root, { recursive: true, force: true })
  }
})

it('saves binary content back to the same file and advances its version', async () => {
  const f = await fixture()
  const bytes = Buffer.from([80, 75, 0, 254, 2])
  const saved = await upload(f.store, f.document, bytes)
  expect(saved.id).toBe(f.document.id)
  expect(saved.version).not.toBe(f.document.version)
  expect(saved.recovery).toBe(false)
  expect(await readFile(f.path)).toEqual(bytes)
  expect((await f.store.list(plugin))).toHaveLength(1)
})
it('keeps recovery content and the external file when a save conflicts', async () => {
  const f = await fixture()
  const draft = Buffer.from('unsaved\0draft')
  await writeFile(f.path, 'external')
  await expect(upload(f.store, f.document, draft)).rejects.toThrow('FILE_CONFLICT')
  expect(await readFile(f.path, 'utf8')).toBe('external')
  const recovered = await f.store.read(plugin, 'view', f.document.id, 0, 100, true, signal)
  expect(Buffer.from(recovered.base64, 'base64')).toEqual(draft)
  expect((await f.store.list(plugin))[0].recovery).toBe(true)
})
it('restores a draft across store restarts without changing its disk source', async () => {
  const f = await fixture()
  const original = await readFile(f.path)
  await upload(f.store, f.document, Buffer.from('recovery'), 'draft')
  f.store.close(plugin, 'view')
  const restarted = new ExtensionWorkingCopyStore(join(f.home, 'extensions'), f.ports)
  const doc = await restarted.reopen(plugin, 'next', f.document.id, signal, current)
  expect(doc.recovery).toBe(true)
  expect(await readFile(f.path)).toEqual(original)
  expect(Buffer.from((await restarted.read(plugin, 'next', doc.id, 0, 100, true, signal)).base64, 'base64').toString()).toBe('recovery')
})
it('does not grant a second view write access to the same file', async () => {
  const f = await fixture()
  const second = await f.store.openPath(plugin, 'second', f.path, signal, current)
  expect(second.writable).toBe(false)
  const writer = await f.store.begin(plugin, 'second', { id: second.id, version: second.version, revision: second.revision, size: 1, mode: 'save', operationId: randomUUID() }, null, signal, current)
  await writer.append(0, 'YQ==')
  await expect(writer.commit()).rejects.toThrow('READ_ONLY')
  await writer.dispose()
})
it('checks Save As against the destination selected before upload starts', async () => {
  const f = await fixture()
  const destination = join(f.root, 'copy.xlsx')
  await writeFile(destination, 'old')
  const writer = await f.store.begin(plugin, 'view', { name: 'copy.xlsx', version: null, size: 3, mode: 'saveAs', operationId: randomUUID() }, destination, signal, current)
  await writeFile(destination, 'external')
  await writer.append(0, Buffer.from('new').toString('base64'))
  await expect(writer.commit()).rejects.toThrow('FILE_CONFLICT')
  await writer.dispose()
  expect(await readFile(destination, 'utf8')).toBe('external')
})
it('resolves a lost commit reply from the native operation receipt', async () => {
  const f = await fixture()
  f.store.close(plugin, 'view')
  const store = new ExtensionWorkingCopyStore(join(f.home, 'extensions'), { ...f.ports, commit: async (...args) => {
    await f.ports.commit(...args)
    throw new Error('lost reply')
  } })
  const doc = await store.reopen(plugin, 'view', f.document.id, signal, current)
  const saved = await upload(store, doc, Buffer.from('saved'))
  expect(saved.recovery).toBe(false)
  expect(await readFile(f.path, 'utf8')).toBe('saved')
})
it('revokes editing grants without deleting recovery data or the original', async () => {
  const f = await fixture()
  await upload(f.store, f.document, Buffer.from('draft'), 'draft')
  await f.store.forget(plugin)
  const recovery = await f.store.reopen(plugin, 'view', f.document.id, signal, current)
  expect(recovery.writable).toBe(false)
  expect(Buffer.from((await f.store.read(plugin, 'view', recovery.id, 0, 100, true, signal)).base64, 'base64').toString()).toBe('draft')
  await expect(f.store.read(plugin, 'view', recovery.id, 0, 100, false, signal)).rejects.toThrow('REVOKED')
  expect(await readFile(f.path)).toEqual(Buffer.from([80, 75, 0, 255, 1]))
  const reopened = await f.store.openPath(plugin, 'view', f.path, signal, current)
  expect(reopened.recovery).toBe(true)
})

it('rejects mixed versions while reading a changing recovery snapshot in chunks', async () => {
  const f = await fixture()
  const draft = await upload(f.store, f.document, Buffer.from('first draft'), 'draft')
  const first = await f.store.read(plugin, 'view', f.document.id, 0, 5, true, signal)
  await upload(f.store, draft, Buffer.from('second draft'), 'draft')
  await expect(f.store.read(plugin, 'view', f.document.id, 5, 100, true, signal, first.contentVersion)).rejects.toThrow('FILE_CONFLICT')
})
it('a refused removal of a recovery record does not revoke its active session', async () => {
  const f = await fixture()
  const draft = await upload(f.store, f.document, Buffer.from('draft'), 'draft')
  await expect(f.store.forget(plugin, f.document.id)).rejects.toThrow('RECOVERY_EXISTS')
  const saved = await upload(f.store, draft, Buffer.from('saved'))
  expect(saved.recovery).toBe(false)
})
it('recovers an unsaved draft after the original file was deleted', async () => {
  const f = await fixture()
  await upload(f.store, f.document, Buffer.from('recover after deletion'), 'draft')
  f.store.close(plugin, 'view')
  await rm(f.path)
  const document = await f.store.reopen(plugin, 'view', f.document.id, signal, current)
  expect(document.recovery).toBe(true)
  const read = await f.store.read(plugin, 'view', document.id, 0, 100, true, signal)
  expect(Buffer.from(read.base64, 'base64').toString()).toBe('recover after deletion')
  const destination = join(f.root, 'recovered.xlsx')
  await upload(f.store, document, Buffer.from('recover after deletion'), 'saveAs', destination)
  expect(await readFile(destination, 'utf8')).toBe('recover after deletion')
})

it('discarding an untitled draft removes its recent record without deleting saved files', async () => {
  const f = await fixture()
  const draft = await upload(f.store, f.document, Buffer.from('untitled'), 'create')
  expect(draft.kind).toBe('draft')
  await f.store.discard(plugin, 'view', draft.id, current)
  expect((await f.store.list(plugin)).map(item => item.id)).toEqual([f.document.id])
  expect(await readFile(f.path)).toEqual(Buffer.from([80, 75, 0, 255, 1]))
})

it('a second view cannot advance the active writer version after an external change', async () => {
  const f = await fixture()
  await writeFile(f.path, 'external edit')
  const second = await f.store.openPath(plugin, 'other', f.path, signal, current)
  expect(second.writable).toBe(false)
  expect(second.version).toBe(f.document.version)
  expect(await f.store.status(plugin, 'view', f.document.id, signal)).toEqual({ changed: true })
  await expect(upload(f.store, f.document, Buffer.from('writer buffer'))).rejects.toThrow('FILE_CONFLICT')
  expect(await readFile(f.path, 'utf8')).toBe('external edit')
})

it('recovers private content when its original parent directory was moved', async () => {
  const f = await fixture()
  const directory = join(f.root, 'source')
  await mkdir(directory)
  const path = join(directory, 'drawing.bin')
  await writeFile(path, 'original')
  const document = await f.store.openPath(plugin, 'view', path, signal, current)
  await upload(f.store, document, Buffer.from('recover me'), 'draft')
  f.store.close(plugin, 'view')
  await rename(directory, join(f.root, 'moved'))
  const restarted = new ExtensionWorkingCopyStore(join(f.home, 'extensions'), f.ports)
  const recovered = await restarted.reopen(plugin, 'view', document.id, signal, current)
  expect(recovered.writable).toBe(false)
  const bytes = await restarted.read(plugin, 'view', recovered.id, 0, 100, true, signal)
  expect(Buffer.from(bytes.base64, 'base64').toString()).toBe('recover me')
  const saved = join(f.root, 'recovered.bin')
  await upload(restarted, recovered, Buffer.from(bytes.base64, 'base64'), 'saveAs', saved)
  expect(await readFile(saved, 'utf8')).toBe('recover me')
})

it('protects untitled working copies from other views and stale revisions', async () => {
  const f = await fixture()
  const draft = await upload(f.store, f.document, Buffer.from('original draft'), 'create')
  const second = await f.store.reopen(plugin, 'second', draft.id, signal, current)
  expect(second.writable).toBe(false)
  const writer = await f.store.begin(plugin, 'second', { id: second.id, version: second.version, revision: second.revision, size: 6, mode: 'draft', operationId: randomUUID() }, null, signal, current)
  await writer.append(0, Buffer.from('second').toString('base64'))
  await expect(writer.commit()).rejects.toThrow('READ_ONLY')
  await writer.dispose()
  const updated = await upload(f.store, draft, Buffer.from('current draft'), 'draft')
  expect(updated.version).toBeNull()
  expect(updated.revision).not.toBe(draft.revision)
  await expect(upload(f.store, draft, Buffer.from('stale draft'), 'draft')).rejects.toThrow('FILE_CONFLICT')
  const bytes = await f.store.read(plugin, 'view', draft.id, 0, 100, true, signal)
  expect(Buffer.from(bytes.base64, 'base64').toString()).toBe('current draft')
  f.store.close(plugin, 'view', draft.id)
  const acquired = await f.store.reopen(plugin, 'second', draft.id, signal, current)
  expect(acquired.writable).toBe(true)
})

it('settles an interrupted submission before dispatch and permits a new save', async () => {
  const f = await fixture()
  f.store.close(plugin, 'view')
  const unavailable = new ExtensionWorkingCopyStore(join(f.home, 'extensions'), {
    ...f.ports,
    commit: async () => { throw new Error('transport disconnected') },
    query: async () => { throw new Error('transport disconnected') },
  })
  const document = await unavailable.reopen(plugin, 'view', f.document.id, signal, current)
  await expect(upload(unavailable, document, Buffer.from('first attempt'))).rejects.toThrow('transport disconnected')
  unavailable.close(plugin, 'view')
  const restarted = new ExtensionWorkingCopyStore(join(f.home, 'extensions'), f.ports)
  const recovered = await restarted.reopen(plugin, 'view', f.document.id, signal, current)
  expect(recovered.recovery).toBe(true)
  await upload(restarted, recovered, Buffer.from('second attempt'))
  expect(await readFile(f.path, 'utf8')).toBe('second attempt')
})

it('rejects a reused operation identity and retains the unsaved bytes', async () => {
  const f = await fixture()
  const operationId = randomUUID()
  const save = async (document: ExtensionDocument, text: string) => {
    const writer = await f.store.begin(plugin, 'view', { id: document.id, version: document.version, revision: document.revision, size: Buffer.byteLength(text), mode: 'save', operationId }, null, signal, current)
    await writer.append(0, Buffer.from(text).toString('base64'))
    try {
      return await writer.commit()
    }
    finally { await writer.dispose() }
  }
  const first = await save(f.document, 'first save')
  await expect(save(first, 'second save')).rejects.toThrow('FILE_OPERATION_ID_CONFLICT')
  expect(await readFile(f.path, 'utf8')).toBe('first save')
  const recovered = await f.store.reopen(plugin, 'view', first.id, signal, current)
  expect(recovered.recovery).toBe(true)
  expect(Buffer.from((await f.store.read(plugin, 'view', first.id, 0, 100, true, signal)).base64, 'base64').toString()).toBe('second save')
  await upload(f.store, recovered, Buffer.from('second save'))
  expect(await readFile(f.path, 'utf8')).toBe('second save')
})

it('settles conflicting operation identities during and after an active commit', async () => {
  const f = await fixture()
  let attempt: Parameters<LocalDocumentFileService['commit']>[0] | undefined
  const commit = f.ports.commit
  f.ports.commit = (input, lifetime) => {
    attempt = input
    return commit(input, lifetime)
  }
  await upload(f.store, f.document, Buffer.from('saved content'))
  const replay = commit(attempt!)
  const mismatch = { ...attempt!, sha256: '0'.repeat(64) }
  const rejected = { operationId: attempt!.operationId, status: 'not-applied', error: 'FILE_OPERATION_ID_CONFLICT' }
  expect(await commit(mismatch)).toEqual(rejected)
  expect(await f.ports.query(mismatch)).toEqual(rejected)
  expect(await replay).toMatchObject({ status: 'applied', version: attempt!.sha256 })
  expect(await f.ports.query(mismatch)).toEqual(rejected)
  expect(await readFile(f.path, 'utf8')).toBe('saved content')
})

it('does not interpret an acknowledged unknown operation as a successful save', async () => {
  const f = await fixture()
  let attempt: Parameters<LocalDocumentFileService['commit']>[0] | undefined
  f.store.close(plugin, 'view')
  const store = new ExtensionWorkingCopyStore(join(f.home, 'extensions'), {
    ...f.ports,
    commit: async (input, lifetime) => {
      attempt = input
      await f.ports.commit(input, lifetime)
      throw new Error('lost reply')
    },
    query: async () => { throw new Error('disconnected') },
  })
  const document = await store.reopen(plugin, 'view', f.document.id, signal, current)
  await expect(upload(store, document, Buffer.from('saved'))).rejects.toThrow('lost reply')
  const record = (await f.engine.query(attempt!.operationId))!
  await f.engine.dispose()
  const { DatabaseSync } = await import('node:sqlite')
  const database = new DatabaseSync(join(f.home, 'operations', 'operations.sqlite'))
  record.status = 'executing'
  record.receipt = null
  database.prepare('UPDATE operations SET record=?,status=? WHERE id=?').run(JSON.stringify(record), JSON.stringify(record.status), record.operationId)
  database.close()
  await writeFile(f.path, 'original')
  const engine = new NativeFileEngine(join(f.home, 'operations'))
  fixtures.find(item => item.engine === f.engine)!.engine = engine
  await engine.ready()
  await engine.register('recovery', f.root)
  await engine.acknowledge('recovery', record.operationId)
  const service = new LocalDocumentFileService(f.home, engine, async () => f.path)
  expect((await service.query(attempt!)).status).toBe('needs-recovery')
  const restarted = new ExtensionWorkingCopyStore(join(f.home, 'extensions'), { ...f.ports, commit: service.commit.bind(service), query: service.query.bind(service) })
  const recovered = await restarted.reopen(plugin, 'view', document.id, signal, current)
  expect(recovered.recovery).toBe(true)
  expect(recovered.version).toBe(document.version)
  expect(await readFile(f.path, 'utf8')).toBe('original')
  await restarted.discard(plugin, 'view', document.id, current)
  await restarted.forget(plugin, document.id)
  expect(await restarted.list(plugin)).toEqual([])
})

it('reads the previous index without dropping recovery and upgrades it on the next mutation', async () => {
  const f = await fixture()
  const draft = await upload(f.store, f.document, Buffer.from('retained draft'), 'draft')
  f.store.close(plugin, 'view')
  const index = join(f.home, 'extensions', 'data', plugin, 'documents', 'index.json')
  const { copies: [copy] } = JSON.parse(await readFile(index, 'utf8'))
  await writeFile(index, JSON.stringify([{ id: copy.id, name: copy.name, path: copy.file.path, parentIdentity: copy.file.parentIdentity, identity: copy.file.identity, version: copy.file.version, snapshot: copy.base.key, size: copy.base.size, openedAt: copy.openedAt, readonly: copy.file.readonly, draft: copy.recovery }]))
  const restarted = new ExtensionWorkingCopyStore(join(f.home, 'extensions'), f.ports)
  expect((await restarted.list(plugin))[0]).toMatchObject({ id: draft.id, recovery: true, revision: draft.revision })
  expect(Array.isArray(JSON.parse(await readFile(index, 'utf8')))).toBe(true)
  const recovered = await restarted.reopen(plugin, 'view', draft.id, signal, current)
  expect(Buffer.from((await restarted.read(plugin, 'view', recovered.id, 0, 100, true, signal)).base64, 'base64').toString()).toBe('retained draft')
  expect(JSON.parse(await readFile(index, 'utf8')).version).toBe(1)
})

it('keeps a new recovery upload intact when previous cleanup is still running', async () => {
  const f = await fixture()
  const original = await readFile(f.path)
  const entered = Promise.withResolvers<void>()
  const proceed = Promise.withResolvers<void>()
  const put = FileAssetStore.prototype.put
  const collect = FileAssetStore.prototype.collect
  let collecting = false
  let overlapping: ReturnType<FileAssetStore['put']> | undefined
  const writeSpy = vi.spyOn(FileAssetStore.prototype, 'put').mockImplementation(function (this: FileAssetStore, ...args) {
    const result = put.apply(this, args)
    if (collecting)
      overlapping = result
    return result
  })
  const collectSpy = vi.spyOn(FileAssetStore.prototype, 'collect').mockImplementationOnce(async function (this: FileAssetStore, retained) {
    collecting = true
    entered.resolve()
    try {
      await proceed.promise
      await overlapping
      await collect.call(this, retained)
    }
    finally { collecting = false }
  })
  const cleanup = f.store.discard(plugin, 'view', f.document.id, current)
  let saving: Promise<ExtensionDocument> | undefined
  try {
    await entered.promise
    saving = upload(f.store, f.document, Buffer.from('new recovery content'), 'draft')
    proceed.resolve()
    await cleanup
    const saved = await saving
    expect(saved.recovery).toBe(true)
    expect(await readFile(f.path)).toEqual(original)
    f.store.close(plugin, 'view')
    const restarted = new ExtensionWorkingCopyStore(join(f.home, 'extensions'), f.ports)
    const restored = await restarted.reopen(plugin, 'view', saved.id, signal, current)
    const bytes = await restarted.read(plugin, 'view', restored.id, 0, 100, true, signal)
    expect(Buffer.from(bytes.base64, 'base64').toString()).toBe('new recovery content')
  }
  finally {
    proceed.resolve()
    await Promise.allSettled([cleanup, saving])
    collectSpy.mockRestore()
    writeSpy.mockRestore()
  }
})
