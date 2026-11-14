import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createBuddyUserContent } from '../../../../shared/conversation/buddyUserContent'
import { ComposerDraftService } from '../../chat/ComposerDraftService'
import { CommandAdmissionService, createLocalCommandPrincipal } from '../../commands/CommandAdmissionService'
import { ProductContentReferences } from '../../productProtocol/ProductContentReferences'
import { ProductReadViews } from '../../productProtocol/ProductReadViews'
import { createAttachmentPersistenceRepository } from '../../storage/attachmentPersistenceRepository'
import { createAttachmentRepository } from '../../storage/attachmentRepository'
import { createComposerDraftRepository } from '../../storage/composerDraftRepository'
import { openBuddyMigrationCandidate } from '../../storage/database'
import { RemoteUploadService } from '../RemoteUploadService'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'lexora-upload-'))
  const database = openBuddyMigrationCandidate({ databasePath: join(root, 'buddy.sqlite3') })
  database.exec('UPDATE storage_profile SET authority = \'sqlite\', migration_state = \'ready\'')
  const repository = createComposerDraftRepository(database)
  const draft = repository.open({ draftId: 'draft', scope: { kind: 'task', draftId: 'draft', spaceId: null }, initialContent: createBuddyUserContent('保留输入'), initialExecutionConfig: { approvalPolicy: 'policy', executionProfile: 'read_only' }, initialModelSelection: null, now: new Date().toISOString() })
  const drafts = new ComposerDraftService(repository, async () => {})
  const local = createLocalCommandPrincipal(database)
  let active = true
  const principal = { actorId: local.actorId, assertAuthenticated: () => {
    if (!active)
      throw new Error('REVOKED')
    local.assertAuthenticated()
  } }
  const admission = new CommandAdmissionService({ database, principal, sourceInstanceId: 'instance' })
  let service = new RemoteUploadService({ database, root, instanceId: 'instance', drafts })
  const commands = () => service.commands(principal, admission)
  const envelope = (commandId: string, intent: unknown) => ({ dataGeneration: database.prepare('SELECT data_generation FROM storage_profile').get()!.data_generation, expectedServiceInstanceId: 'instance', commandId, intent })
  const create = async (bytes: Uint8Array, id = 'create') => {
    const result = await commands().execute('uploads.create', envelope(id, { draftId: 'draft', expectedRevision: repository.findById('draft')!.revision, file: { name: '示例.txt', mimeType: 'text/plain', sizeBytes: bytes.length, sha256: hash(bytes) } }))
    return String(result.receipt.result.uploadId)
  }
  const server = createServer((request, response) => {
    void service.bytes(request, response, principal).catch((error) => {
      response.statusCode = 409
      response.end(JSON.stringify({ error: error.code ?? error.message }))
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address() as { port: number }
  const put = async (id: string, bytes: Uint8Array, start: number, total: number, digest = hash(bytes)) => {
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/uploads/${id}`, { method: 'PUT', headers: { 'Content-Range': `bytes ${start}-${start + bytes.length - 1}/${total}`, 'Content-Length': String(bytes.length), 'X-Content-SHA256': digest }, body: Buffer.from(bytes) })
    return { status: response.status, body: await response.json() }
  }
  const restart = async () => {
    await service.close()
    createAttachmentPersistenceRepository(database).recover('next')
    service = new RemoteUploadService({ database, root, instanceId: 'next', drafts })
  }
  cleanups.push(async () => {
    await service.close()
    await admission.dispose()
    await drafts.dispose()
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    database.close()
    await rm(root, { recursive: true, force: true })
  })
  return { root, database, repository, draft, commands, envelope, create, put, restart, service: () => service, revoke: () => active = false }
}

describe('durable remote uploads', () => {
  it('acknowledges exact chunks, resumes only the proven prefix, and publishes the same immutable resource on replay', async () => {
    const f = await fixture()
    const bytes = Buffer.from('first second')
    const id = await f.create(bytes)
    expect(await f.put(id, bytes.subarray(0, 6), 0, bytes.length)).toMatchObject({ status: 200, body: { confirmedBytes: 6 } })
    expect(await f.put(id, bytes.subarray(0, 6), 0, bytes.length)).toMatchObject({ status: 200, body: { confirmedBytes: 6 } })
    expect((await f.put(id, Buffer.from('other '), 0, bytes.length)).status).toBe(409)
    const path = String(f.database.prepare('SELECT temporary_path FROM managed_files').get()!.temporary_path)
    await appendFile(path, 'unconfirmed')
    await f.restart()
    expect(await f.commands().get(id)).toMatchObject({ state: 'receiving', confirmedBytes: 6 })
    expect(await readFile(path, 'utf8')).toBe('first ')
    expect((await f.put(id, bytes.subarray(6), 6, bytes.length)).status).toBe(200)
    const envelope = f.envelope('complete', { uploadId: id })
    const ready = await f.commands().execute('uploads.complete', envelope)
    expect(ready.receipt.decision).toBe('accepted')
    expect(await f.commands().execute('uploads.complete', envelope)).toEqual({ created: false, receipt: ready.receipt })
    expect(await f.commands().get(id)).toMatchObject({ state: 'ready', contentVersion: hash(bytes) })
    expect(f.database.prepare('SELECT state FROM file_preparations').get()!.state).toBe('settled')
    expect(createAttachmentPersistenceRepository(f.database).candidates()).toEqual([])
  })

  it('stages input attachments without creating or modifying a composer draft and releases cancelled bytes', async () => {
    const f = await fixture()
    const before = f.repository.findById('draft')
    const bytes = Buffer.from('Local input attachment 😀')
    const request = f.envelope('stage-local', { inputId: 'local-input', file: { name: 'local.txt', mimeType: 'text/plain', sizeBytes: bytes.length, sha256: hash(bytes) } })
    const created = await f.commands().execute('uploads.stage', request)
    const id = String(created.receipt.result.uploadId)
    expect(await f.commands().execute('uploads.stage', request)).toEqual({ created: false, receipt: created.receipt })
    expect((await f.put(id, bytes, 0, bytes.length)).status).toBe(200)
    await f.commands().execute('uploads.complete', f.envelope('complete-local', { uploadId: id }))
    const ready = await f.commands().get(id)
    expect(ready).toMatchObject({ state: 'ready', inputId: 'local-input', confirmedBytes: bytes.length, contentVersion: hash(bytes) })
    expect(ready.attachmentId).toBeTruthy()
    const owner = createLocalCommandPrincipal(f.database).actorId
    const ownViews = new ProductReadViews(f.database, owner, new ProductContentReferences(f.database, owner))
    const otherViews = new ProductReadViews(f.database, 'another-device', new ProductContentReferences(f.database, 'another-device'))
    expect(ownViews.resource(`attachment:${ready.attachmentId}`)).toMatchObject({ availability: 'ready' })
    expect(otherViews.resource(`attachment:${ready.attachmentId}`)).toBeNull()
    expect(() => f.repository.open({ ...f.draft, draftId: ready.draftId, scope: { kind: 'task', draftId: ready.draftId, spaceId: null }, initialContent: createBuddyUserContent('collision'), initialModelSelection: null, initialExecutionConfig: f.draft.executionConfig, now: new Date().toISOString() })).toThrow('draft revision conflicts')
    expect(f.repository.findById('draft')).toEqual(before)
    expect(f.database.prepare('SELECT count(*) AS count FROM composer_drafts').get()).toEqual({ count: 1 })
    expect(f.database.prepare('SELECT draft_id FROM composer_resources WHERE id = ?').get(ready.resourceId)).toEqual({ draft_id: ready.draftId })
    const forbidden = await f.commands().execute('uploads.adopt', f.envelope('wrong-adoption', { uploadId: id, draftId: 'draft', expectedRevision: 0 }))
    expect(forbidden.receipt).toMatchObject({ decision: 'rejected', errorCode: 'DRAFT_CONFLICT' })
    await f.commands().execute('uploads.cancel', f.envelope('cancel-local', { uploadId: id }))
    f.service().sweep()
    expect(createAttachmentRepository(f.database).findById(ready.attachmentId!)).toBeNull()
    expect(f.database.prepare('SELECT id FROM composer_resources WHERE id = ?').get(ready.resourceId)).toBeUndefined()
    expect(f.repository.findById('draft')).toEqual(before)
  })

  it('keeps ready bytes on draft conflict and adopts once without overwriting text', async () => {
    const f = await fixture()
    const bytes = Buffer.from('attached')
    const id = await f.create(bytes)
    await f.put(id, bytes, 0, bytes.length)
    await f.commands().execute('uploads.complete', f.envelope('complete', { uploadId: id }))
    f.repository.save({ draftId: 'draft', expectedRevision: 0, content: createBuddyUserContent('新输入'), executionConfig: f.draft.executionConfig, modelSelection: null, now: new Date().toISOString() })
    const conflict = await f.commands().execute('uploads.adopt', f.envelope('stale', { uploadId: id, draftId: 'draft', expectedRevision: 0 }))
    expect(conflict.receipt).toMatchObject({ decision: 'rejected', errorCode: 'DRAFT_CONFLICT' })
    expect(await f.commands().get(id)).toMatchObject({ state: 'ready' })
    const envelope = f.envelope('adopt', { uploadId: id, draftId: 'draft', expectedRevision: 1 })
    const adopted = await f.commands().execute('uploads.adopt', envelope)
    expect(adopted.receipt).toMatchObject({ decision: 'accepted', result: { revision: 2 } })
    expect(await f.commands().execute('uploads.adopt', envelope)).toEqual({ created: false, receipt: adopted.receipt })
    expect(f.repository.findById('draft')!.content).toEqual(createBuddyUserContent('新输入'))
    const attachment = createAttachmentRepository(f.database).findById(String(adopted.receipt.result.attachmentId))!
    expect(await readFile(attachment.storedPath)).toEqual(bytes)
    await f.commands().execute('uploads.cancel', f.envelope('cancel', { uploadId: id }))
    expect(await f.commands().get(id)).toMatchObject({ state: 'adopted' })
    expect(createAttachmentPersistenceRepository(f.database).candidates()).toEqual([])
  })

  it('rejects a corrupt confirmed prefix on restart and releases only its own file to GC', async () => {
    const f = await fixture()
    const bytes = Buffer.from('original')
    const id = await f.create(bytes)
    await f.put(id, bytes, 0, bytes.length)
    const path = String(f.database.prepare('SELECT temporary_path FROM managed_files').get()!.temporary_path)
    await writeFile(path, 'corrupt!')
    await f.restart()
    await expect(f.commands().get(id)).rejects.toThrow('RESOURCE_UNAVAILABLE')
    expect(await f.commands().get(id)).toMatchObject({ state: 'failed' })
    expect(createAttachmentPersistenceRepository(f.database).candidates()).toHaveLength(1)
    expect(f.database.prepare('SELECT reserved_bytes FROM file_preparations').get()!.reserved_bytes).toBe(0)
  })

  it('keeps bytes but confirms no prefix if the chunk transaction fails', async () => {
    const f = await fixture()
    const bytes = Buffer.from('transaction')
    const id = await f.create(bytes)
    f.database.exec('CREATE TRIGGER fail_chunk BEFORE INSERT ON remote_upload_chunks BEGIN SELECT RAISE(ABORT, \'fixture\'); END')
    expect((await f.put(id, bytes, 0, bytes.length)).status).toBe(409)
    expect(f.database.prepare('SELECT confirmed_bytes FROM remote_uploads').get()!.confirmed_bytes).toBe(0)
    f.database.exec('DROP TRIGGER fail_chunk')
    await f.restart()
    expect(await f.commands().get(id)).toMatchObject({ confirmedBytes: 0 })
    expect((await f.put(id, bytes, 0, bytes.length)).status).toBe(200)
  })

  it('bounds reservations, rejects foreign owners and refuses acceptance after authorization loss', async () => {
    const f = await fixture()
    const bytes = Buffer.from('small')
    const ids = await Promise.all([0, 1, 2, 3].map(index => f.create(bytes, `create-${index}`)))
    await expect(f.create(bytes, 'overflow')).rejects.toThrow('LIMIT_EXCEEDED')
    const reservation = f.database.prepare('SELECT SUM(reserved_bytes) AS bytes FROM file_preparations WHERE state = \'preparing\'').get()!.bytes
    expect(reservation).toBe(20)
    await f.commands().execute('uploads.cancel', f.envelope('cancel', { uploadId: ids[0] }))
    await f.create(bytes, 'replacement')
    f.revoke()
    expect((await f.put(ids[1]!, bytes, 0, bytes.length)).status).toBe(409)
    await expect(f.commands().execute('uploads.complete', f.envelope('revoked', { uploadId: ids[1] }))).rejects.toThrow()
    expect(f.database.prepare('SELECT 1 FROM command_receipts WHERE command_id = \'revoked\'').get()).toBeUndefined()
  })
})
