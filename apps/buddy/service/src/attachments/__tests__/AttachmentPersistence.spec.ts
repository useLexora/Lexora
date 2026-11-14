import type { DatabaseSync } from 'node:sqlite'
import { Buffer } from 'node:buffer'
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createAttachmentRepository } from '../../storage/attachmentRepository'
import { BuddyDataPaths } from '../../storage/BuddyDataPaths'
import { createConversationRepository } from '../../storage/conversationRepository'
import { openBuddyMigrationCandidate } from '../../storage/database'
import { withTransaction } from '../../storage/transaction'
import { AttachmentService } from '../AttachmentService'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'lexora-persistent-attachments-'))
  const databasePath = join(root, 'data.sqlite3')
  let database = openBuddyMigrationCandidate({ databasePath })
  database.exec('UPDATE storage_profile SET authority = \'sqlite\', migration_state = \'ready\'')
  const paths = new BuddyDataPaths(join(root, 'profile'))
  let repository = createAttachmentRepository(database)
  let service = new AttachmentService({ paths, repository })
  cleanups.push(async () => {
    await service.dispose()
    database.close()
    await rm(root, { recursive: true, force: true })
  })
  return {
    root,
    paths,
    get database() { return database },
    get repository() { return repository },
    get service() { return service },
    async reopen() {
      await service.dispose()
      database.close()
      database = openBuddyMigrationCandidate({ databasePath })
      repository = createAttachmentRepository(database)
      service = new AttachmentService({ paths, repository })
    },
    async upload() {
      const [record] = await service.registerUploads('draft-1', [{ name: 'source.txt', mimeType: 'text/plain', bytes: Buffer.from('source bytes') }])
      return record!
    },
  }
}

function message(database: DatabaseSync) {
  createConversationRepository(database).create({ id: 'conversation-1', branchId: 'branch-1', createdAt: '2026-10-01T00:00:00.000Z', spaceId: null, title: null, approvalPolicy: 'manual', executionProfile: 'read_only' })
  database.prepare(`INSERT INTO messages (id, conversation_id, branch_id, role, content_json, created_at)
    VALUES ('message-1', 'conversation-1', 'branch-1', 'user', '{}', '2026-10-01T00:00:00.000Z')`).run()
}

async function prepare(fixture: Awaited<ReturnType<typeof setup>>) {
  const record = await fixture.upload()
  const prepared = await fixture.service.prepareMessageAttachments({ attachmentIds: [record.id], conversationId: 'conversation-1', draftId: 'draft-1', messageId: 'message-1' })
  return { record, prepared, target: prepared.bindings[0]!.storedPath }
}

function bind(database: DatabaseSync, path: string, id: string) {
  return database.prepare('UPDATE attachments SET draft_id = NULL, message_id = \'message-1\', stored_path = ? WHERE id = ?').run(path, id)
}

describe('persistent managed attachment lifecycle', () => {
  it('protects source and destination through preparation and atomically changes ownership', async () => {
    const fixture = await setup()
    const { record, prepared, target } = await prepare(fixture)
    const persistence = fixture.repository.persistence!
    message(fixture.database)
    expect(await fixture.service.release([record.id])).toEqual([])
    expect(persistence.claim(record.storedPath)).toBeNull()
    expect(persistence.claim(target)).toBeNull()
    expect(() => withTransaction(fixture.database, () => {
      bind(fixture.database, target, record.id)
      throw new Error('abort command')
    })).toThrow('abort command')
    expect(fixture.repository.findById(record.id)?.storedPath).toBe(record.storedPath)
    expect(fixture.database.prepare('SELECT kind FROM file_references').all()).toEqual([{ kind: 'draft' }])
    withTransaction(fixture.database, () => bind(fixture.database, target, record.id))
    await prepared.commit()
    expect(persistence.get(record.storedPath)?.state).toBe('deleted')
    expect(fixture.database.prepare('SELECT kind, owner_id FROM file_references').all()).toEqual([{ kind: 'message', owner_id: 'message-1' }])
    expect((await readFile(target)).toString()).toBe('source bytes')
    await expect(readFile(record.storedPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects a late binding after the source owner or actor changes', async () => {
    const fixture = await setup()
    const { record, prepared, target } = await prepare(fixture)
    message(fixture.database)
    fixture.database.prepare('UPDATE attachments SET draft_id = \'other\' WHERE id = ?').run(record.id)
    expect(() => withTransaction(fixture.database, () => bind(fixture.database, target, record.id))).toThrow('FILE_SOURCE_CHANGED')
    fixture.database.prepare('UPDATE attachments SET draft_id = \'draft-1\' WHERE id = ?').run(record.id)
    fixture.database.exec('UPDATE storage_actors SET state = \'revoked\'')
    expect(() => withTransaction(fixture.database, () => bind(fixture.database, target, record.id))).toThrow('FILE_PREPARATION_IDENTITY_CHANGED')
    await prepared.rollback()
  })

  it.each([false, true])('retains unknown outcomes until reopen determines persisted ownership: committed=%s', async (committed) => {
    const fixture = await setup()
    const { record, prepared, target } = await prepare(fixture)
    const unknown = join(dirname(record.storedPath), 'unknown.bin')
    await writeFile(unknown, 'not in catalog')
    if (committed) {
      message(fixture.database)
      withTransaction(fixture.database, () => bind(fixture.database, target, record.id))
    }
    await prepared.retain()
    expect((await fixture.service.reconcileStorage()).removedOrphanFiles).toBe(0)
    expect((await readFile(target)).toString()).toBe('source bytes')
    await fixture.reopen()
    await fixture.service.reconcileStorage()
    expect(fixture.repository.persistence!.get(target)?.state).toBe(committed ? 'ready' : 'deleted')
    expect(fixture.repository.persistence!.get(record.storedPath)?.state).toBe(committed ? 'deleted' : 'ready')
    expect((await readFile(unknown)).toString()).toBe('not in catalog')
  })

  it('recovers a deletion claim after unlink without allowing references or path reuse', async () => {
    const fixture = await setup()
    const record = await fixture.upload()
    const persistence = fixture.repository.persistence!
    fixture.repository.removeDraft(record.id)
    const claimed = persistence.claim(record.storedPath)!
    expect(claimed.state).toBe('deleting')
    expect(() => persistence.reference(claimed.id, { kind: 'export', ownerId: 'export-1', bindingId: 'download' })).toThrow('FILE_NOT_READY')
    await unlink(record.storedPath)
    await fixture.reopen()
    await fixture.service.reconcileStorage()
    expect(fixture.repository.persistence!.get(record.storedPath)?.state).toBe('deleted')
    expect(() => fixture.repository.persistence!.prepare({ operationId: 'new', availableBytes: 100, stagingDirectory: join(fixture.root, 'staging'), ownerInstance: 'new', kind: 'import', targetOwnerId: 'draft-2', path: record.storedPath, sizeBytes: 12 })).toThrow()
  })

  it('protects active reads and marks same-size corruption unavailable while retaining references', async () => {
    const fixture = await setup()
    const record = await fixture.upload()
    let release!: () => void
    let reading!: () => void
    const started = new Promise<void>((resolve) => {
      reading = resolve
    })
    const waiting = new Promise<void>((resolve) => {
      release = resolve
    })
    const service = new AttachmentService({ paths: fixture.paths, repository: fixture.repository, readFile: (async (path: string) => {
      reading()
      await waiting
      return readFile(path)
    }) as typeof readFile })
    const pending = service.preparePrompt([record.id], '', null, 'draft-1')
    await started
    expect(await service.release([record.id])).toEqual([])
    release()
    await pending
    await service.dispose()
    await writeFile(record.storedPath, 'broken bytes')
    await expect(fixture.service.readText(record.id, 'draft-1', null)).rejects.toMatchObject({ code: 'ATTACHMENT_INVALID' })
    expect(fixture.repository.persistence!.get(record.storedPath)?.state).toBe('unavailable')
    expect(fixture.database.prepare('SELECT count(*) AS count FROM file_references').get()?.count).toBe(1)
    expect(fixture.repository.findById(record.id)).not.toBeNull()
  })

  it('cleans only cataloged interrupted publications and never adopts partial bytes as ready', async () => {
    const fixture = await setup()
    const path = join(fixture.paths.draftAttachments('interrupted'), 'partial.txt')
    await mkdir(dirname(path), { recursive: true })
    const prepared = fixture.repository.persistence!.prepare({ operationId: 'interrupted', availableBytes: 100, stagingDirectory: join(fixture.root, 'staging'), ownerInstance: 'old', kind: 'import', targetOwnerId: 'interrupted', path, sizeBytes: 12 })
    await mkdir(dirname(prepared.temporaryPath!), { recursive: true })
    await writeFile(prepared.temporaryPath!, 'partial')
    await expect(fixture.service.reconcileStorage()).resolves.toMatchObject({ removedOrphanFiles: 1 })
    expect(fixture.repository.persistence!.get(path)?.state).toBe('deleted')
    await expect(readFile(prepared.temporaryPath!)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('copies a draft into independently owned bytes in the caller transaction', async () => {
    const fixture = await setup()
    const source = await fixture.upload()
    const prepared = await fixture.service.prepareDraftCopy({ sourceDraftId: 'draft-1', targetDraftId: 'draft-2', attachmentIds: [source.id] })
    const target = prepared.records[0]!
    expect(target.id).not.toBe(source.id)
    expect(target.storedPath).not.toBe(source.storedPath)
    expect(fixture.repository.findById(target.id)).toBeNull()
    expect(await fixture.service.release([source.id])).toEqual([])
    expect(() => withTransaction(fixture.database, () => {
      prepared.validate()
      fixture.repository.create(target)
      throw new Error('draft command rolled back')
    })).toThrow('draft command rolled back')
    expect(fixture.repository.findById(target.id)).toBeNull()
    withTransaction(fixture.database, () => {
      prepared.validate()
      fixture.repository.create(target)
    })
    await prepared.commit()
    expect(await fixture.service.release([source.id])).toEqual([source.id])
    expect((await readFile(target.storedPath)).toString()).toBe('source bytes')
    expect(fixture.database.prepare('SELECT kind, owner_id FROM file_references').all()).toEqual([{ kind: 'draft', owner_id: 'draft-2' }])
  })

  it('leaves an uncertain draft copy protected until the reopened owner can verify its reference', async () => {
    const fixture = await setup()
    const source = await fixture.upload()
    const prepared = await fixture.service.prepareDraftCopy({ sourceDraftId: 'draft-1', targetDraftId: 'draft-2', attachmentIds: [source.id] })
    const target = prepared.records[0]!
    await prepared.retain()
    expect(await fixture.service.release([source.id])).toEqual([])
    await fixture.reopen()
    await fixture.service.reconcileStorage()
    expect(fixture.repository.persistence!.get(source.storedPath)?.state).toBe('ready')
    expect(fixture.repository.persistence!.get(target.storedPath)?.state).toBe('deleted')
  })
})
