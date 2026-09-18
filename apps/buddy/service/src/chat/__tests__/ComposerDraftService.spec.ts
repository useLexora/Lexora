import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createBuddyUserContent } from '../../../../shared/conversation/buddyUserContent'
import { AttachmentService } from '../../attachments/AttachmentService'
import { ComposerResourceService } from '../../attachments/ComposerResourceService'
import { createAttachmentRepository } from '../../storage/attachmentRepository'
import { BuddyDataPaths } from '../../storage/BuddyDataPaths'
import { createComposerDraftRepository } from '../../storage/composerDraftRepository'
import { createComposerResourceRepository } from '../../storage/composerResourceRepository'
import { createConversationRepository } from '../../storage/conversationRepository'
import { openBuddyDatabase } from '../../storage/database'
import { ComposerDraftService } from '../ComposerDraftService'

const input = {
  draftId: 'new-input',
  initialContent: createBuddyUserContent('Unsent text'),
  initialExecutionConfig: { approvalPolicy: 'policy' as const, executionProfile: 'workspace_write' as const },
  initialModelSelection: null,
  scope: { kind: 'task' as const, draftId: 'new-input', spaceId: null },
}

describe('composerDraftService lifecycle', () => {
  it('waits for imports, removes only owned copies, and rejects late writes after discard', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lexora-input-discard-'))
    const database = openBuddyDatabase({ databasePath: ':memory:' })
    const drafts = createComposerDraftRepository(database)
    const paths = new BuddyDataPaths(root)
    const attachmentRepository = createAttachmentRepository(database)
    const resourceRepository = createComposerResourceRepository(database)
    const attachments = new AttachmentService({ paths, repository: attachmentRepository })
    const resources = new ComposerResourceService({ attachments, paths, drafts, repository: resourceRepository })
    const service = new ComposerDraftService(drafts, id => resources.discard(id))
    try {
      const source = join(root, 'source.txt')
      await writeFile(source, 'Keep this user file')
      await service.open(input)
      const gate = Promise.withResolvers<void>()
      const started = Promise.withResolvers<void>()
      const importing = service.run(input.draftId, async () => {
        started.resolve()
        await gate.promise
        const bytes = new TextEncoder().encode('Owned copy')
        await resources.accept({ draftId: input.draftId, resources: [{ resourceId: 'owned-resource', name: 'source.txt', mimeType: 'text/plain', sizeBytes: bytes.length, sourcePath: source, storage: 'snapshot' }] })
        const ready = await resources.complete({ draftId: input.draftId, resourceId: 'owned-resource', bytes })
        if (!('attachmentId' in ready))
          throw new Error('Expected a stored attachment')
        return [attachmentRepository.findById(ready.attachmentId)!]
      })
      await started.promise
      const discarding = service.discard({ draftId: input.draftId, expectedRevision: 0 })
      expect(drafts.findById(input.draftId)).not.toBeNull()
      gate.resolve()
      const [attachment] = await importing
      expect(await discarding).toBe(true)
      expect(drafts.findById(input.draftId)).toBeNull()
      expect(attachmentRepository.listAll()).toEqual([])
      await expect(stat(attachment!.storedPath)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(paths.draftAttachments(input.draftId))).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await readFile(source, 'utf8')).toBe('Keep this user file')
      await expect(service.save({ draftId: input.draftId, expectedRevision: 0, content: input.initialContent, executionConfig: input.initialExecutionConfig, modelSelection: null })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
      await expect(service.run(input.draftId, () => resources.accept({ draftId: input.draftId, resources: [] }))).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
      expect(resourceRepository.listForDraft(input.draftId)).toEqual([])
    }
    finally {
      database.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('retains a draft that becomes a conversation input while discard waits', async () => {
    const database = openBuddyDatabase({ databasePath: ':memory:' })
    const drafts = createComposerDraftRepository(database)
    const service = new ComposerDraftService(drafts, async () => {
      throw new Error('Committed resources must remain')
    })
    try {
      await service.open(input)
      const gate = Promise.withResolvers<void>()
      const submission = service.run(input.draftId, async () => {
        await gate.promise
        createConversationRepository(database).create({ id: 'task', branchId: 'branch', spaceId: null, title: 'Task', createdAt: new Date().toISOString(), ...input.initialExecutionConfig })
        database.prepare('UPDATE composer_drafts SET scope_kind = \'conversation_branch\', conversation_id = \'task\', branch_id = \'branch\', revision = 1 WHERE id = ?').run(input.draftId)
      })
      const discarded = service.discard({ draftId: input.draftId, expectedRevision: 0 })
      gate.resolve()
      await submission
      expect(await discarded).toBe(false)
      expect(drafts.findById(input.draftId)?.scope).toEqual({ kind: 'conversation_branch', conversationId: 'task', branchId: 'branch' })
    }
    finally { database.close() }
  })
})
