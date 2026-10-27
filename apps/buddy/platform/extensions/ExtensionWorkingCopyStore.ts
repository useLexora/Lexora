import type { ExtensionDocument, ExtensionDocumentWrite } from '../../shared/extensions/extensionDocuments'
import type { ExtensionFileOpeningSource } from '../../shared/extensions/extensionFileOpening'
import type { LocalDocumentCommit, LocalDocumentReceipt } from '../../shared/files/localDocumentApi'
import type { ExtensionWorkingCopy, WorkingCopyFileBinding } from './extensionWorkingCopy'
import { Buffer } from 'node:buffer'
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { access, lstat, open, realpath } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { extensionIdSchema } from '../../shared/extensions/extensionManifest'
import { FileAssetStore } from '../filesystem/FileAssetStore'
import { readExtensionJson, writeExtensionJson } from './extensionFiles'
import { ExtensionResourceUpload } from './ExtensionResourceUpload'
import { readWorkingCopies, workingCopiesSchema, workingCopyContent } from './extensionWorkingCopy'

export interface ExtensionDocumentPorts {
  commit: (input: LocalDocumentCommit, signal: AbortSignal) => Promise<LocalDocumentReceipt>
  query: (input: LocalDocumentCommit) => Promise<LocalDocumentReceipt>
  resolve: (source: ExtensionFileOpeningSource, signal: AbortSignal) => Promise<string>
  reveal: (path: string) => Promise<void>
}
interface Owner { extensionId: string, viewId: string, documentId: string }

export class ExtensionWorkingCopyStore {
  readonly #queues = new Map<string, Promise<unknown>>()
  readonly #writers = new Map<string, Owner>()
  readonly #files = new Map<string, Owner>()
  readonly #sessions = new Map<string, Set<string>>()
  readonly #uploads = new Map<string, number>()
  private readonly root: string
  private readonly ports: ExtensionDocumentPorts
  constructor(root: string, ports: ExtensionDocumentPorts) {
    this.root = root
    this.ports = ports
  }

  private files(extensionId: string) {
    return new FileAssetStore(join(this.root, 'data', extensionIdSchema.parse(extensionId), 'documents', 'files'))
  }

  private index(extensionId: string) {
    return join(this.root, 'data', extensionIdSchema.parse(extensionId), 'documents', 'index.json')
  }

  private async copies(extensionId: string): Promise<ExtensionWorkingCopy[]> {
    try {
      return readWorkingCopies(await readExtensionJson(this.index(extensionId)), extensionId)
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return []
      throw error
    }
  }

  private queue<T>(id: string, action: () => Promise<T>): Promise<T> {
    const next = (this.#queues.get(id) ?? Promise.resolve()).catch(() => {}).then(action)
    this.#queues.set(id, next)
    void next.finally(() => {
      if (this.#queues.get(id) === next)
        this.#queues.delete(id)
    }).catch(() => {})
    return next
  }

  private persist(extensionId: string, copies: ExtensionWorkingCopy[], current: () => void) {
    const assets = new Map(copies.flatMap(copy => [[copy.base.key, copy.base.size], ...(copy.recovery ? [[copy.recovery.key, copy.recovery.size]] : []), ...(copy.saving ? [[copy.saving.sha256, copy.saving.size]] : [])] as [string, number][]))
    if ([...assets.values()].reduce((total, size) => total + size, 0) > 1024 * 1024 * 1024)
      throw new Error('EXTENSION_DOCUMENT_STORAGE_LIMIT')
    return writeExtensionJson(this.index(extensionId), workingCopiesSchema.parse({ version: 1, copies }), current)
  }

  private present(extensionId: string, copy: ExtensionWorkingCopy, viewId?: string, available = true): ExtensionDocument {
    const content = workingCopyContent(copy)
    const owner = this.#writers.get(`${extensionId}:${copy.id}`)
    return {
      id: copy.id,
      name: copy.name,
      location: copy.file ? `${basename(dirname(copy.file.path))}/${copy.name}` : '未保存到文件',
      version: copy.file?.version ?? null,
      revision: content.key,
      size: content.size,
      writable: available && !copy.file?.revoked && !copy.file?.readonly && !!owner && owner.viewId === viewId,
      kind: copy.file ? 'file' : 'draft',
      recovery: !!copy.recovery,
      openedAt: copy.openedAt,
    }
  }

  private session(extensionId: string, viewId: string, copy: ExtensionWorkingCopy) {
    const key = `${extensionId}:${viewId}`
    const ids = this.#sessions.get(key) ?? new Set<string>()
    ids.add(copy.id)
    this.#sessions.set(key, ids)
    const writerKey = `${extensionId}:${copy.id}`
    const fileOwner = copy.file ? this.#files.get(copy.file.path) : undefined
    if (!this.#writers.has(writerKey) && !fileOwner) {
      const owner = { extensionId, viewId, documentId: copy.id }
      this.#writers.set(writerKey, owner)
      if (copy.file)
        this.#files.set(copy.file.path, owner)
    }
  }

  private assertSession(extensionId: string, viewId: string, id: string, write = false) {
    if (!this.#sessions.get(`${extensionId}:${viewId}`)?.has(id))
      throw new Error('EXTENSION_DOCUMENT_EXPIRED')
    if (write && this.#writers.get(`${extensionId}:${id}`)?.viewId !== viewId)
      throw new Error('EXTENSION_DOCUMENT_READ_ONLY')
  }

  private async validate(file: WorkingCopyFileBinding, signal: AbortSignal) {
    signal.throwIfAborted()
    if (file.revoked)
      throw new Error('EXTENSION_DOCUMENT_REVOKED')
    if (file.source && await this.ports.resolve(file.source, signal) !== file.path)
      throw new Error('EXTENSION_DOCUMENT_REVOKED')
    if (await realpath(dirname(file.path)) !== dirname(file.path))
      throw new Error('FILE_CONFLICT')
    const stat = await lstat(dirname(file.path), { bigint: true })
    if (`${stat.dev}:${stat.ino}` !== file.parentIdentity)
      throw new Error('FILE_CONFLICT')
    signal.throwIfAborted()
  }

  private async snapshot(extensionId: string, path: string, signal: AbortSignal, current: () => void) {
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    try {
      const stat = await handle.stat({ bigint: true })
      if (!stat.isFile() || stat.size > 256n * 1024n * 1024n)
        throw new Error('EXTENSION_DOCUMENT_SIZE_LIMIT')
      const fingerprint = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}`
      const body = Readable.toWeb(handle.createReadStream({ autoClose: false, start: 0, end: Math.max(0, Number(stat.size) - 1) })) as ReadableStream<Uint8Array>
      const asset = await this.files(extensionId).put(body, signal, current)
      const after = await lstat(path, { bigint: true })
      if (fingerprint !== `${after.dev}:${after.ino}:${after.size}:${after.mtimeNs}` || await realpath(path) !== path)
        throw new Error('FILE_CONFLICT')
      return { content: asset, identity: `${stat.dev}:${stat.ino}` }
    }
    finally { await handle.close() }
  }

  list(extensionId: string) {
    return this.queue(extensionId, async () => (await this.copies(extensionId)).sort((a, b) => b.openedAt - a.openedAt).map(copy => this.present(extensionId, copy)))
  }

  openPath(extensionId: string, viewId: string, path: string, signal: AbortSignal, current: () => void, source?: ExtensionFileOpeningSource): Promise<ExtensionDocument> {
    return this.queue(extensionId, async () => {
      const canonical = await realpath(path)
      const copies = await this.copies(extensionId)
      let copy = copies.find(item => item.file?.path === canonical && JSON.stringify(item.file.source) === JSON.stringify(source))
      if (copy)
        await this.settle(copy, current)
      const parent = await lstat(dirname(canonical), { bigint: true })
      const snapshot = await this.snapshot(extensionId, canonical, signal, current)
      const file: WorkingCopyFileBinding = { path: canonical, parentIdentity: `${parent.dev}:${parent.ino}`, identity: snapshot.identity, version: snapshot.content.key, readonly: await access(canonical, constants.W_OK).then(() => false, () => true), revoked: false, ...(source ? { source } : {}) }
      await this.validate(file, signal)
      if (!copy) {
        copy = { id: randomUUID(), name: basename(canonical), base: snapshot.content, file, openedAt: Date.now() }
        copies.push(copy)
      }
      else if (!copy.recovery && !copy.saving && !this.#files.has(canonical)) {
        Object.assign(copy, { file, base: snapshot.content })
      }
      current()
      signal.throwIfAborted()
      copy.file!.revoked = false
      copy.openedAt = Date.now()
      await this.persist(extensionId, copies, current)
      current()
      signal.throwIfAborted()
      this.session(extensionId, viewId, copy)
      await this.collect(extensionId)
      return this.present(extensionId, copy, viewId)
    })
  }

  reopen(extensionId: string, viewId: string, id: string, signal: AbortSignal, current: () => void): Promise<ExtensionDocument> {
    return this.queue(extensionId, async () => {
      const copies = await this.copies(extensionId)
      const copy = copies.find(item => item.id === id)
      if (!copy)
        throw new Error('EXTENSION_DOCUMENT_NOT_FOUND')
      await this.settle(copy, current)
      let available = true
      if (copy.file) {
        try {
          await this.validate(copy.file, signal)
          if (!copy.recovery && !copy.saving && !this.#files.has(copy.file.path)) {
            const snapshot = await this.snapshot(extensionId, copy.file.path, signal, current)
            copy.base = snapshot.content
            copy.file.version = snapshot.content.key
            copy.file.identity = snapshot.identity
          }
          else {
            await access(copy.file.path)
          }
        }
        catch (error) {
          signal.throwIfAborted()
          current()
          if (!copy.recovery)
            throw error
          available = false
        }
      }
      copy.openedAt = Date.now()
      await this.persist(extensionId, copies, current)
      current()
      signal.throwIfAborted()
      this.session(extensionId, viewId, copy)
      return this.present(extensionId, copy, viewId, available)
    })
  }

  async read(extensionId: string, viewId: string, id: string, offset: number, length: number, recovery: boolean, signal: AbortSignal, contentVersion?: string) {
    this.assertSession(extensionId, viewId, id)
    const copy = (await this.copies(extensionId)).find(item => item.id === id)
    if (!copy)
      throw new Error('EXTENSION_DOCUMENT_NOT_FOUND')
    const fromRecovery = recovery && !!copy.recovery
    if (!fromRecovery && copy.file)
      await this.validate(copy.file, signal)
    const content = fromRecovery ? copy.recovery! : copy.base
    if (contentVersion && contentVersion !== content.key)
      throw new Error('FILE_CONFLICT')
    const handle = await open(this.files(extensionId).path(content.key), 'r')
    try {
      const bytes = Buffer.alloc(Math.min(length, Math.max(0, content.size - offset)))
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, offset)
      if (!fromRecovery && copy.file)
        await this.validate(copy.file, signal)
      signal.throwIfAborted()
      this.assertSession(extensionId, viewId, id)
      return { base64: bytes.subarray(0, bytesRead).toString('base64'), size: content.size, contentVersion: content.key, eof: offset + bytesRead >= content.size }
    }
    finally { await handle.close() }
  }

  async status(extensionId: string, viewId: string, id: string, signal: AbortSignal) {
    this.assertSession(extensionId, viewId, id)
    const copy = (await this.copies(extensionId)).find(item => item.id === id)
    if (!copy)
      throw new Error('EXTENSION_DOCUMENT_NOT_FOUND')
    if (!copy.file)
      return { changed: false }
    const file = copy.file
    await this.validate(file, signal)
    const handle = await open(file.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT')
        return null
      throw error
    })
    if (!handle)
      return { changed: true }
    try {
      const stat = await handle.stat({ bigint: true })
      if (!stat.isFile() || stat.size > 256n * 1024n * 1024n)
        return { changed: true }
      const digest = createHash('sha256')
      for await (const bytes of handle.createReadStream({ autoClose: false, start: 0, end: Math.max(0, Number(stat.size) - 1) })) {
        signal.throwIfAborted()
        digest.update(bytes)
      }
      const after = await lstat(file.path, { bigint: true })
      this.assertSession(extensionId, viewId, id)
      await this.validate(file, signal)
      return { changed: digest.digest('hex') !== file.version || `${after.dev}:${after.ino}` !== file.identity || after.mtimeNs !== stat.mtimeNs || after.size !== stat.size }
    }
    finally { await handle.close() }
  }

  async begin(extensionId: string, viewId: string, input: ExtensionDocumentWrite, path: string | null, signal: AbortSignal, current: () => void) {
    let selected: WorkingCopyFileBinding | null = null
    if (input.mode === 'saveAs' && path) {
      const parent = await realpath(dirname(path))
      path = join(parent, basename(path))
      if (this.#files.has(path))
        throw new Error('EXTENSION_DOCUMENT_ALREADY_OPEN')
      const stat = await lstat(parent, { bigint: true })
      selected = { path, version: null, identity: '', parentIdentity: `${stat.dev}:${stat.ino}`, readonly: false, revoked: false }
      try {
        const target = path
        const old = await this.queue(extensionId, () => this.snapshot(extensionId, target, signal, current))
        selected.version = old.content.key
        selected.identity = old.identity
      }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
          throw error
      }
    }
    await this.queue(extensionId, async () => {
      current()
      signal.throwIfAborted()
      this.#uploads.set(extensionId, (this.#uploads.get(extensionId) ?? 0) + 1)
    })
    const upload = new ExtensionResourceUpload<ExtensionDocument>(input.size, async (body, uploadSignal) => {
      const lifetime = AbortSignal.any([signal, uploadSignal])
      const asset = await this.files(extensionId).put(body, lifetime, current)
      return this.queue(extensionId, async () => {
        const copies = await this.copies(extensionId)
        let copy = input.id ? copies.find(item => item.id === input.id) : undefined
        if (input.mode === 'saveAs' || input.mode === 'create') {
          if (selected && this.#files.has(selected.path))
            throw new Error('EXTENSION_DOCUMENT_ALREADY_OPEN')
          if (!input.name)
            throw new Error('EXTENSION_DOCUMENT_NAME_REQUIRED')
          const existing = selected ? copies.find(item => item.file?.path === selected.path && !item.file.source) : undefined
          if (existing?.recovery || existing?.saving)
            throw new Error('EXTENSION_DOCUMENT_RECOVERY_EXISTS')
          copy = existing ?? { id: randomUUID(), name: selected ? basename(selected.path) : input.name, file: selected, base: asset, openedAt: Date.now() }
          copy.file = selected
          if (!existing)
            copies.push(copy)
        }
        else {
          if (!copy)
            throw new Error('EXTENSION_DOCUMENT_NOT_FOUND')
          this.assertSession(extensionId, viewId, copy.id, true)
          if ((copy.file?.version ?? null) !== input.version || workingCopyContent(copy).key !== input.revision)
            throw new Error('FILE_CONFLICT')
        }
        current()
        lifetime.throwIfAborted()
        copy.recovery = asset
        await this.persist(extensionId, copies, current)
        current()
        lifetime.throwIfAborted()
        this.session(extensionId, viewId, copy)
        this.assertSession(extensionId, viewId, copy.id, true)
        if (input.mode === 'draft' || input.mode === 'create')
          return this.present(extensionId, copy, viewId)
        if (!copy.file)
          throw new Error('EXTENSION_DOCUMENT_SAVE_AS_REQUIRED')
        await this.settle(copy, current)
        if (copy.saving)
          throw new Error('FILE_RECOVERY_REQUIRED')
        const file = copy.file
        await this.validate(file, lifetime)
        if (file.readonly)
          throw new Error('EXTENSION_DOCUMENT_READ_ONLY')
        if (file.version !== null) {
          const stat = await lstat(file.path, { bigint: true })
          if (`${stat.dev}:${stat.ino}` !== file.identity)
            throw new Error('FILE_CONFLICT')
        }
        const attempt: LocalDocumentCommit = { extensionId, operationId: input.operationId, path: file.path, parentIdentity: file.parentIdentity, expected: file.version, sha256: asset.key, size: asset.size, ...(file.source ? { source: file.source } : {}) }
        copy.saving = attempt
        await this.persist(extensionId, copies, current)
        let receipt: LocalDocumentReceipt
        try {
          current()
          lifetime.throwIfAborted()
          this.assertSession(extensionId, viewId, copy.id, true)
          receipt = await this.ports.commit(attempt, lifetime)
        }
        catch (error) {
          try {
            receipt = await this.ports.query(attempt)
          }
          catch { throw error }
        }
        await this.applyReceipt(copy, receipt)
        await this.persist(extensionId, copies, () => {})
        if (receipt.status !== 'applied')
          throw new Error(receipt.error ?? 'FILE_RECOVERY_REQUIRED')
        current()
        return this.present(extensionId, copy, viewId)
      })
    }, current)
    void upload.finished.finally(async () => {
      const active = (this.#uploads.get(extensionId) ?? 1) - 1
      if (active)
        this.#uploads.set(extensionId, active)
      else this.#uploads.delete(extensionId)
      await this.queue(extensionId, () => this.collect(extensionId))
    }).catch(() => {})
    return upload
  }

  private async collect(extensionId: string) {
    if (this.#uploads.get(extensionId))
      return
    const copies = await this.copies(extensionId)
    await this.files(extensionId).collect(new Set(copies.flatMap(copy => [copy.base.key, ...(copy.recovery ? [copy.recovery.key] : []), ...(copy.saving ? [copy.saving.sha256] : [])])))
  }

  private async applyReceipt(copy: ExtensionWorkingCopy, receipt: LocalDocumentReceipt) {
    const attempt = copy.saving
    if (!attempt)
      return
    if (receipt.operationId !== attempt.operationId)
      throw new Error('FILE_OPERATION_ID_CONFLICT')
    if (receipt.status === 'applied') {
      if (receipt.version !== attempt.sha256 || !copy.file || copy.file.path !== attempt.path)
        throw new Error('FILE_OPERATION_ID_CONFLICT')
      copy.file.version = receipt.version
      copy.base = { key: attempt.sha256, size: attempt.size }
      if (copy.recovery?.key === attempt.sha256)
        delete copy.recovery
      const stat = await lstat(copy.file.path, { bigint: true }).catch(() => undefined)
      if (stat)
        copy.file.identity = `${stat.dev}:${stat.ino}`
    }
    if (receipt.status !== 'pending')
      delete copy.saving
  }

  private async settle(copy: ExtensionWorkingCopy, current: () => void) {
    if (!copy.saving)
      return
    await this.applyReceipt(copy, await this.ports.query(copy.saving))
    current()
  }

  discard(extensionId: string, viewId: string, id: string, current: () => void) {
    return this.queue(extensionId, async () => {
      const copies = await this.copies(extensionId)
      const copy = copies.find(item => item.id === id)
      if (!copy)
        return
      this.assertSession(extensionId, viewId, id, true)
      await this.settle(copy, current)
      if (copy.saving)
        throw new Error('FILE_RECOVERY_REQUIRED')
      delete copy.recovery
      await this.persist(extensionId, copy.file ? copies : copies.filter(item => item !== copy), current)
      if (!copy.file)
        this.close(extensionId, viewId, id)
      await this.collect(extensionId)
    })
  }

  async reveal(extensionId: string, viewId: string, id: string, signal: AbortSignal) {
    this.assertSession(extensionId, viewId, id)
    const copy = (await this.copies(extensionId)).find(item => item.id === id)
    if (copy?.file) {
      await this.validate(copy.file, signal)
      await this.ports.reveal(copy.file.path)
    }
  }

  close(extensionId: string, viewId: string, id?: string) {
    const matches = (owner: Owner) => owner.extensionId === extensionId && owner.viewId === viewId && (!id || owner.documentId === id)
    for (const [key, owner] of this.#writers) {
      if (matches(owner))
        this.#writers.delete(key)
    }
    for (const [path, owner] of this.#files) {
      if (matches(owner))
        this.#files.delete(path)
    }
    if (id)
      this.#sessions.get(`${extensionId}:${viewId}`)?.delete(id)
    else this.#sessions.delete(`${extensionId}:${viewId}`)
  }

  forget(extensionId: string, id?: string) {
    return this.queue(extensionId, async () => {
      const copies = await this.copies(extensionId)
      const removed = copies.filter(copy => !id || copy.id === id)
      if (id && removed.some(copy => copy.recovery || copy.saving))
        throw new Error('EXTENSION_DOCUMENT_RECOVERY_EXISTS')
      if (!id) {
        for (const copy of removed) {
          if (copy.file)
            copy.file.revoked = true
        }
      }
      await this.persist(extensionId, id ? copies.filter(copy => !removed.includes(copy)) : copies, () => {})
      for (const key of [...this.#sessions.keys()]) {
        if (key.startsWith(`${extensionId}:`))
          this.close(extensionId, key.slice(extensionId.length + 1), id)
      }
      await this.collect(extensionId)
    })
  }
}
