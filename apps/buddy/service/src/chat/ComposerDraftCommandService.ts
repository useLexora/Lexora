import type { DatabaseSync } from 'node:sqlite'
import type { BuddyComposerDraft, BuddyComposerDraftScope } from '../../../shared/conversation/composerDraft'
import type { PreparedDraftAttachmentCopy } from '../attachments/AttachmentService'
import type { CommandAdmissionService, CommandResolution } from '../commands/CommandAdmissionService'
import type { InputCommandIntent } from '../commands/commandIntent'
import type { CommandDecision, CommandRejection } from '../storage/CommandCommitter'
import type { ComposerDraftService } from './ComposerDraftService'
import { randomUUID } from 'node:crypto'
import { buddyUserContentV1Schema, getBuddyUserContentResourceIds } from '../../../shared/conversation/buddyUserContent'
import { createAttachmentRepository } from '../storage/attachmentRepository'
import { ComposerDraftConflictError, createComposerDraftRepository, findPersonalComposerDraft } from '../storage/composerDraftRepository'
import { createDraftOwnershipRepository } from '../storage/draftOwnershipRepository'
import { afterTransactionCommit } from '../storage/transaction'
import { PreparedResourceSettlement } from './PreparedResourceSettlement'

interface DraftCommandOptions {
  database: DatabaseSync
  actorId: string
  admission: Pick<CommandAdmissionService, 'execute' | 'lookup'>
  drafts: Pick<ComposerDraftService, 'run' | 'withDraftLock' | 'notifyCommitted'>
  prepareAttachments: (input: { sourceDraftId: string, targetDraftId: string, attachmentIds: readonly string[] }) => Promise<PreparedDraftAttachmentCopy>
  releaseResources: (draftId: string) => Promise<void>
  onCleanupError: (error: unknown) => void
}

type DraftCommandMethod = 'composerDrafts.open' | 'composerDrafts.save' | 'composerDrafts.discard' | 'composerDrafts.copy'
interface PreparedDraftCommand {
  files?: PreparedDraftAttachmentCopy
  commit: () => { decision: CommandDecision, draft: BuddyComposerDraft, kind: 'opened' | 'saved' | 'discarded' }
}
interface CopyResourceRow {
  id: string
  attachment_id: string | null
  draft_id: string
  state: string
  [key: string]: unknown
}

export class ComposerDraftCommandService {
  readonly #options: DraftCommandOptions
  readonly #cleanups = new Set<Promise<void>>()

  constructor(options: DraftCommandOptions) {
    this.#options = options
  }

  async execute(method: DraftCommandMethod, input: unknown): Promise<CommandResolution> {
    const { database, admission, drafts, onCleanupError } = this.#options
    let resources: PreparedResourceSettlement | undefined
    try {
      const resolution = await admission.execute(method, input, {
        scope: (intent, operation) => method === 'composerDrafts.copy'
          ? drafts.withDraftLock((intent as InputCommandIntent<'composerDrafts.copy'>).sourceDraftId, operation)
          : method === 'composerDrafts.open'
            ? drafts.withDraftLock((intent as InputCommandIntent<'composerDrafts.open'>).draftId, operation)
            : drafts.run('sourceDraftId' in intent ? intent.sourceDraftId : intent.draftId, operation),
        prepare: async (intent, signal) => {
          signal.throwIfAborted()
          const prepared = await this.#prepare(method, intent)
          resources = new PreparedResourceSettlement(prepared.files, onCleanupError)
          signal.throwIfAborted()
          return prepared
        },
        reject: rejectDraftCommand,
        commit: (value) => {
          value.files?.validate()
          const outcome = value.commit()
          afterTransactionCommit(database, () => {
            this.#cleanup(resources!.commit())
            drafts.notifyCommitted(outcome.kind, outcome.draft)
            if (outcome.kind === 'discarded')
              this.#cleanup(this.#options.releaseResources(outcome.draft.draftId))
          }, onCleanupError)
          return outcome.decision
        },
      })
      await resources?.rollback()
      return resolution
    }
    catch (error) {
      await resources?.fail(error)
      throw error
    }
  }

  async dispose(): Promise<void> {
    await Promise.allSettled(this.#cleanups)
  }

  async #prepare(method: DraftCommandMethod, intent: Readonly<InputCommandIntent<DraftCommandMethod>>): Promise<PreparedDraftCommand> {
    const { database, actorId } = this.#options
    const repository = createComposerDraftRepository(database, actorId)
    if (method === 'composerDrafts.open') {
      const input = intent as InputCommandIntent<'composerDrafts.open'>
      return { commit: () => {
        const ownership = createDraftOwnershipRepository(database, actorId)
        if ((ownership.findSlot(input.scope)?.slotRevision ?? 0) !== input.expectedSlotRevision)
          throw new DraftCommandConflict('DRAFT_CONFLICT')
        if (database.prepare('SELECT 1 FROM composer_drafts WHERE id = ? AND owner_actor_id != ?').get(input.draftId, actorId))
          throw new DraftCommandConflict('DRAFT_CONFLICT')
        requireResourceOwnership(database, input.draftId, getBuddyUserContentResourceIds(input.initialContent))
        const draft = repository.open({ ...input, now: new Date().toISOString() })
        const slot = ownership.findSlot(input.scope)!
        return { draft, kind: 'opened', decision: { target: { draftId: draft.draftId }, result: { draftId: draft.draftId, revision: draft.revision, slotRevision: slot.slotRevision } } }
      } }
    }
    if (method === 'composerDrafts.save') {
      const input = intent as InputCommandIntent<'composerDrafts.save'>
      return { commit: () => {
        requireResourceOwnership(database, input.draftId, getBuddyUserContentResourceIds(input.content))
        const draft = repository.save({ ...input, now: new Date().toISOString() })
        return { draft, kind: 'saved', decision: { target: { draftId: draft.draftId }, result: { draftId: draft.draftId, revision: draft.revision } } }
      } }
    }
    if (method === 'composerDrafts.discard') {
      const input = intent as InputCommandIntent<'composerDrafts.discard'>
      const draft = repository.findById(input.draftId)
      if (!draft)
        throw new DraftCommandConflict('OBJECT_DELETED')
      return { commit: () => {
        if (!repository.discard(input))
          throw new DraftCommandConflict('DRAFT_CONFLICT')
        return { draft, kind: 'discarded', decision: { target: { draftId: draft.draftId }, result: { discarded: true } } }
      } }
    }
    const input = intent as InputCommandIntent<'composerDrafts.copy'>
    const source = findPersonalComposerDraft(database, input.sourceDraftId)
    if (!source || source.revision !== input.expectedSourceRevision)
      throw new DraftCommandConflict('DRAFT_CONFLICT')
    const recovered = input.recoveredInput ? { ...source, ...input.recoveredInput } : source
    const content = buddyUserContentV1Schema.parse(recovered.content)
    const resourceIds = getBuddyUserContentResourceIds(content)
    const resources = requireResourceOwnership(database, source.draftId, resourceIds)
    if (resources.some(resource => resource.state !== 'ready'))
      throw new DraftCommandConflict('RESOURCE_UNAVAILABLE')
    const draftId = randomUUID()
    const scope: BuddyComposerDraftScope = input.targetScope.kind === 'task' ? { ...input.targetScope, draftId } : input.targetScope
    const files = await this.#options.prepareAttachments({ sourceDraftId: source.draftId, targetDraftId: draftId, attachmentIds: resources.flatMap(resource => resource.attachment_id ? [resource.attachment_id] : []) })
    const resourceMap = new Map(resourceIds.map(id => [id, randomUUID()]))
    const copiedContent = {
      ...content,
      body: content.body.map(paragraph => ({ ...paragraph, content: paragraph.content.map(node => node.type === 'resource_ref' ? { ...node, resourceId: resourceMap.get(node.resourceId)! } : node) })),
      panelResourceIds: content.panelResourceIds.map(id => resourceMap.get(id)!),
    }
    return { files, commit: () => {
      if (findPersonalComposerDraft(database, source.draftId)?.revision !== input.expectedSourceRevision
        || JSON.stringify(requireResourceOwnership(database, source.draftId, resourceIds)) !== JSON.stringify(resources)) {
        throw new DraftCommandConflict('DRAFT_CONFLICT')
      }
      const ownership = createDraftOwnershipRepository(database, actorId)
      if ((ownership.findSlot(scope)?.slotRevision ?? 0) !== input.expectedSlotRevision)
        throw new DraftCommandConflict('DRAFT_CONFLICT')
      const now = new Date().toISOString()
      database.prepare(`INSERT INTO composer_drafts
        (id, scope_kind, space_id, conversation_id, branch_id, source_message_id, revision,
          content_json, model_selection_json, participants_json, approval_policy, execution_profile, created_at, updated_at, owner_actor_id)
        VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        draftId,
        scope.kind,
        'spaceId' in scope ? scope.spaceId : null,
        'conversationId' in scope ? scope.conversationId : null,
        'branchId' in scope ? scope.branchId : null,
        scope.kind === 'message_edit' ? scope.userMessageId : scope.kind === 'message_followup' ? scope.assistantMessageId : null,
        JSON.stringify(copiedContent),
        recovered.modelSelection ? JSON.stringify(recovered.modelSelection) : null,
        recovered.participants ? JSON.stringify(recovered.participants) : null,
        recovered.executionConfig.approvalPolicy,
        recovered.executionConfig.executionProfile,
        now,
        now,
        actorId,
      )
      const attachments = createAttachmentRepository(database)
      const attachmentIds = resources.flatMap(resource => resource.attachment_id ? [resource.attachment_id] : [])
      if (files.records.length !== attachmentIds.length)
        throw new Error('Draft attachment preparation does not match its source')
      for (const record of files.records)
        attachments.create({ ...record })
      const attachmentMap = new Map(attachmentIds.map((id, index) => [id, files.records[index]!.id]))
      const copy = database.prepare(`INSERT INTO composer_resources
        (id, draft_id, name, mime_type, size_bytes, state, attachment_id, content_hash, source_json, error_code, created_at, updated_at, name_source, source_path)
        SELECT ?, ?, name, mime_type, size_bytes, state, ?, content_hash, source_json, error_code, ?, ?, name_source, source_path
        FROM composer_resources WHERE id = ? AND draft_id = ?`)
      for (const resource of resources)
        copy.run(resourceMap.get(resource.id)!, draftId, resource.attachment_id ? attachmentMap.get(resource.attachment_id)! : null, now, now, resource.id, source.draftId)
      const slot = ownership.select(scope, draftId, input.expectedSlotRevision)
      const draft = repository.findById(draftId)!
      return { draft, kind: 'opened', decision: {
        target: { draftId, sourceDraftId: source.draftId },
        result: { draftId, revision: draft.revision, slotRevision: slot.slotRevision, sourceRevision: source.revision },
      } }
    } }
  }

  #cleanup(promise: Promise<void>): void {
    const cleanup = promise.catch(this.#options.onCleanupError).finally(() => this.#cleanups.delete(cleanup))
    this.#cleanups.add(cleanup)
  }
}

function requireResourceOwnership(database: DatabaseSync, draftId: string, ids: readonly string[]): CopyResourceRow[] {
  return ids.map((id) => {
    const row = database.prepare('SELECT * FROM composer_resources WHERE id = ? AND draft_id = ?').get(id, draftId) as CopyResourceRow | undefined
    if (!row)
      throw new DraftCommandConflict('RESOURCE_UNAVAILABLE')
    return row
  })
}

class DraftCommandConflict extends Error {
  readonly code: CommandRejection['errorCode']

  constructor(code: CommandRejection['errorCode']) {
    super(code)
    this.code = code
  }
}

function rejectDraftCommand(error: unknown): CommandRejection | null {
  return error instanceof DraftCommandConflict || error instanceof ComposerDraftConflictError
    ? { errorCode: error.code, target: {}, result: {} }
    : null
}
