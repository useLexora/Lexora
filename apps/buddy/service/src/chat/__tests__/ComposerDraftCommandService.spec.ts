import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createBuddyUserContent } from '../../../../shared/conversation/buddyUserContent'
import { AttachmentService } from '../../attachments/AttachmentService'
import { ComposerResourceService } from '../../attachments/ComposerResourceService'
import { CommandAdmissionService, createLocalCommandPrincipal } from '../../commands/CommandAdmissionService'
import { createAttachmentRepository } from '../../storage/attachmentRepository'
import { BuddyDataPaths } from '../../storage/BuddyDataPaths'
import { createComposerDraftRepository } from '../../storage/composerDraftRepository'
import { createComposerResourceRepository } from '../../storage/composerResourceRepository'
import { createConversationTreeRepository } from '../../storage/conversationTreeRepository'
import { openBuddyMigrationCandidate } from '../../storage/database'
import { createDraftOwnershipRepository } from '../../storage/draftOwnershipRepository'
import { ComposerDraftCommandService } from '../ComposerDraftCommandService'
import { ComposerDraftService } from '../ComposerDraftService'

const cleanups: (() => Promise<void>)[] = []
const now = '2026-11-07T00:00:00.000Z'
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse())
    await cleanup()
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'lexora-draft-commands-'))
  const database = openBuddyMigrationCandidate({ databasePath: join(root, 'buddy.sqlite3') })
  database.exec('UPDATE storage_profile SET authority = \'sqlite\', migration_state = \'ready\'')
  const repository = createComposerDraftRepository(database)
  const open = (id: string, global = false) => repository.open({ draftId: id, initialContent: createBuddyUserContent(id), initialExecutionConfig: { approvalPolicy: 'policy', executionProfile: 'read_only' }, initialModelSelection: null, now, scope: global ? { kind: 'global' } : { kind: 'task', draftId: id, spaceId: null } })
  const source = open('source')
  const previous = open('previous', true)
  const attachments = new AttachmentService({ paths: new BuddyDataPaths(root), repository: createAttachmentRepository(database) })
  const resources = new ComposerResourceService({ attachments, paths: new BuddyDataPaths(root), repository: createComposerResourceRepository(database), publications: createConversationTreeRepository(database), drafts: repository })
  const drafts = new ComposerDraftService(repository, id => resources.discard(id))
  const principal = createLocalCommandPrincipal(database)
  const admission = new CommandAdmissionService({ database, principal, sourceInstanceId: 'instance' })
  const errors: unknown[] = []
  const commands = new ComposerDraftCommandService({ database, actorId: principal.actorId, admission, drafts, prepareAttachments: input => attachments.prepareDraftCopy(input), releaseResources: id => resources.discard(id), onCleanupError: error => errors.push(error) })
  cleanups.push(async () => {
    await commands.dispose()
    await admission.dispose()
    await drafts.dispose()
    await resources.dispose()
    await attachments.dispose()
    database.close()
    await rm(root, { recursive: true, force: true })
  })
  const envelope = (commandId: string, intent: unknown) => ({ commandId, intent, expectedServiceInstanceId: 'instance', dataGeneration: database.prepare('SELECT data_generation FROM storage_profile').get()!.data_generation })
  return { root, database, repository, source, previous, attachments, drafts, commands, principal, errors, envelope }
}

describe('conditional composer draft commands', () => {
  it('opens one owner slot atomically and replays the original result after it is saved', async () => {
    const f = await fixture()
    const intent = { draftId: 'opened', scope: { kind: 'task', draftId: 'opened', spaceId: null }, initialContent: createBuddyUserContent('initial'), initialExecutionConfig: f.source.executionConfig, initialModelSelection: null, expectedSlotRevision: 0 }
    const input = f.envelope('open', intent)
    const accepted = await f.commands.execute('composerDrafts.open', input)
    expect(accepted.receipt).toMatchObject({ decision: 'accepted', target: { draftId: 'opened' }, result: { revision: 0, slotRevision: 1 } })
    f.repository.save({ draftId: 'opened', expectedRevision: 0, content: createBuddyUserContent('newer local input'), executionConfig: f.source.executionConfig, modelSelection: null, now })
    expect(await f.commands.execute('composerDrafts.open', input)).toEqual({ created: false, receipt: accepted.receipt })
    const rejected = await f.commands.execute('composerDrafts.open', f.envelope('stale-open', intent))
    expect(rejected.receipt).toMatchObject({ decision: 'rejected', errorCode: 'DRAFT_CONFLICT' })
    expect(f.repository.findById('opened')?.revision).toBe(1)
  })

  it('copies independent files and IDs, preserves the displaced draft, and replays after source changes', async () => {
    const f = await fixture()
    await mkdir(join(f.root, 'drafts/source/attachments'), { recursive: true })
    const [attachment] = await f.attachments.registerUploads('source', [{ name: 'sample.txt', mimeType: 'text/plain', bytes: new TextEncoder().encode('kept bytes') }])
    const resources = createComposerResourceRepository(f.database)
    resources.accept('source', [{ resourceId: 'resource', name: 'sample.txt', mimeType: 'text/plain', sizeBytes: 10 }], now)
    resources.finish({ draftId: 'source', resourceId: 'resource', attachmentId: attachment!.id, contentHash: 'hash', now })
    const source = f.repository.save({ draftId: 'source', expectedRevision: 0, content: { ...createBuddyUserContent('source'), panelResourceIds: ['resource'] }, executionConfig: f.source.executionConfig, modelSelection: null, now })
    const slot = createDraftOwnershipRepository(f.database, f.principal.actorId).findSlot({ kind: 'global' })!
    const input = f.envelope('copy', { sourceDraftId: 'source', expectedSourceRevision: source.revision, targetScope: { kind: 'global' }, expectedSlotRevision: slot.slotRevision })
    const accepted = await f.commands.execute('composerDrafts.copy', input)
    const draftId = String(accepted.receipt.target.draftId)
    expect(accepted.receipt.decision).toBe('accepted')
    expect(draftId).not.toBe('source')
    const copied = f.repository.findById(draftId)!
    expect(copied.content.panelResourceIds).toHaveLength(1)
    expect(copied.content.panelResourceIds[0]).not.toBe('resource')
    const copiedResources = resources.listForDraft(draftId)
    const copiedAttachment = createAttachmentRepository(f.database).findById(copiedResources[0]!.attachmentId!)!
    expect(copiedAttachment.storedPath).not.toBe(attachment!.storedPath)
    expect(await readFile(copiedAttachment.storedPath, 'utf8')).toBe('kept bytes')
    expect(await readFile(attachment!.storedPath, 'utf8')).toBe('kept bytes')
    expect({ ...f.repository.findById('previous'), slotRevision: undefined }).toEqual({ ...f.previous, slotRevision: undefined })
    expect(f.repository.findByScope({ kind: 'global' })?.draftId).toBe(draftId)
    f.repository.save({ draftId: 'source', expectedRevision: source.revision, content: createBuddyUserContent('new source'), executionConfig: source.executionConfig, modelSelection: null, now })
    expect(await f.commands.execute('composerDrafts.copy', input)).toEqual({ created: false, receipt: accepted.receipt })
    const recovered = await f.commands.execute('composerDrafts.copy', f.envelope('recover-input', {
      sourceDraftId: 'source',
      expectedSourceRevision: source.revision + 1,
      targetScope: { kind: 'task', spaceId: null },
      expectedSlotRevision: 0,
      recoveredInput: { content: { ...createBuddyUserContent('unconfirmed local edits'), panelResourceIds: ['resource'] }, executionConfig: source.executionConfig, modelSelection: null },
    }))
    const recoveredDraft = f.repository.findById(String(recovered.receipt.target.draftId))!
    expect(recovered.receipt.decision).toBe('accepted')
    expect(recoveredDraft.content.body).toEqual(createBuddyUserContent('unconfirmed local edits').body)
    expect(recoveredDraft.content.panelResourceIds[0]).not.toBe('resource')
    expect(await readFile(createAttachmentRepository(f.database).findById(resources.listForDraft(recoveredDraft.draftId)[0]!.attachmentId!)!.storedPath, 'utf8')).toBe('kept bytes')
    const discard = f.envelope('discard-source', { draftId: 'source', expectedRevision: source.revision + 1 })
    const discarded = await f.commands.execute('composerDrafts.discard', discard)
    expect(discarded.receipt.decision).toBe('accepted')
    expect(f.repository.findById('source')).toBeNull()
    expect(await f.commands.execute('composerDrafts.discard', discard)).toEqual({ created: false, receipt: discarded.receipt })
    await f.commands.dispose()
    await expect(readFile(attachment!.storedPath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(copiedAttachment.storedPath, 'utf8')).toBe('kept bytes')
    expect(f.repository.findById(draftId)?.content).toEqual(copied.content)
    expect(await f.commands.execute('composerDrafts.copy', input)).toEqual({ created: false, receipt: accepted.receipt })
    expect(f.errors).toEqual([])
  })

  it('rejects an unavailable resource without creating a destination', async () => {
    const f = await fixture()
    createComposerResourceRepository(f.database).accept('source', [{ resourceId: 'pending', name: 'pending.txt', mimeType: 'text/plain', sizeBytes: 1 }], now)
    f.repository.save({ draftId: 'source', expectedRevision: 0, content: { ...createBuddyUserContent('changed'), panelResourceIds: ['pending'] }, executionConfig: f.source.executionConfig, modelSelection: null, now })
    const input = f.envelope('conditional-copy', { sourceDraftId: 'source', expectedSourceRevision: 1, targetScope: { kind: 'task', spaceId: null }, expectedSlotRevision: 0 })
    const outcome = await f.commands.execute('composerDrafts.copy', input)
    expect(outcome.receipt).toMatchObject({ decision: 'rejected', errorCode: 'RESOURCE_UNAVAILABLE' })
    expect(f.database.prepare('SELECT COUNT(*) AS count FROM composer_drafts').get()?.count).toBe(2)
    expect(await f.commands.execute('composerDrafts.copy', input)).toEqual({ created: false, receipt: outcome.receipt })
    expect(f.repository.findByScope({ kind: 'global' })).toEqual(f.previous)
  })

  it('does not replace the destination slot when its CAS loses', async () => {
    const f = await fixture()
    const input = f.envelope('copy-stale-slot', { sourceDraftId: 'source', expectedSourceRevision: 0, targetScope: { kind: 'global' }, expectedSlotRevision: 0 })
    const rejected = await f.commands.execute('composerDrafts.copy', input)
    expect(rejected.receipt).toMatchObject({ decision: 'rejected', errorCode: 'DRAFT_CONFLICT' })
    expect(f.repository.findByScope({ kind: 'global' })).toEqual(f.previous)
    expect(f.database.prepare('SELECT COUNT(*) AS count FROM composer_drafts').get()?.count).toBe(2)
  })
})
