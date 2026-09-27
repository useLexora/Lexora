import type { Api, Model } from '@earendil-works/pi-ai'
import type { FileEntry } from '@earendil-works/pi-coding-agent'
import type { ConversationHistoryRepository } from '../../../storage/conversationHistoryRepository'
import type { RunRecord } from '../../../storage/runRecord'
import type { BuddySessionRecoveryService } from '../recovery/BuddySessionRecoveryService'
import type { BuddyTreeJournal } from './BuddyTreeStore'
import { createHash } from 'node:crypto'
import { BuddyAgentRunError } from '../../../runs/runError'
import { readBuddyInputReference } from '../../context/BuddyInputReference'

export class BuddyTreeRecovery {
  recoveredFromProductHistory = false
  recoveryDegradation: { missingAttachmentIds: readonly string[], recoveredImageCount: number } | undefined

  readonly journal: BuddyTreeJournal
  readonly model: Model<Api>
  readonly options: {
    conversations: Pick<ConversationHistoryRepository, 'listBranchMessages'>
    recovery: Pick<BuddySessionRecoveryService, 'create'>
  }

  constructor(journal: BuddyTreeJournal, model: Model<Api>, options: BuddyTreeRecovery['options']) {
    this.journal = journal
    this.model = model
    this.options = options
  }

  async restore(run: RunRecord, position: 'before' | 'after'): Promise<string> {
    const imported = await this.#importLegacy(run, position)
    if (imported)
      return imported
    const history = this.options.conversations.listBranchMessages(run.conversationId, run.branchId)
    const index = history.findIndex(message => message.id === run.triggeringMessageId)
    const next = history.slice(index + 1).find(message => message.role === 'user')
    const recovered = await this.options.recovery.create({
      branchId: run.branchId,
      conversationId: run.conversationId,
      fallbackModel: this.model,
      point: position === 'before'
        ? { kind: 'before_message', messageId: run.triggeringMessageId }
        : next ? { kind: 'before_message', messageId: next.id } : { kind: 'branch_head' },
    })
    const id = this.journal.appendRecoveredMessages(run, position, recovered.messages)
    this.recoveredFromProductHistory = true
    if (recovered.missingAttachmentIds.length)
      this.recoveryDegradation = { missingAttachmentIds: recovered.missingAttachmentIds, recoveredImageCount: recovered.recoveredImageCount }
    return id
  }

  async #importLegacy(run: RunRecord, position: 'before' | 'after'): Promise<string | null> {
    const source = await this.journal.readLegacy(run.piSessionFile)
    if (!source)
      return null
    const { path, manager: legacy } = source
    const branch = legacy.getBranch()
    const matches = branch.filter(entry => entry.type === 'message'
      && readBuddyInputReference(entry.message)?.messageId === run.triggeringMessageId)
    if (matches.length !== 1)
      return null
    const user = matches[0]!
    const index = branch.indexOf(user)
    const nextIndex = branch.findIndex((entry, i) => i > index && entry.type === 'message' && entry.message.role === 'user')
    const endpoint = position === 'before'
      ? user.parentId
      : branch[(nextIndex < 0 ? branch.length : nextIndex) - 1]!.id
    const mappedId = (id: string) => createHash('sha256').update(`${path}\0${id}`).digest('hex').slice(0, 24)
    const entries = legacy.getEntries()
    const sourceIds = new Set(entries.map(entry => entry.id))
    for (const entry of entries) {
      if (entry.parentId && !sourceIds.has(entry.parentId))
        throw new BuddyAgentRunError('SESSION_STORAGE_UNAVAILABLE')
      if (entry.type === 'context_edit' && !sourceIds.has(entry.targetId))
        throw new BuddyAgentRunError('SESSION_STORAGE_UNAVAILABLE')
    }
    const imported: FileEntry[] = entries.filter(entry => !this.journal.manager.getEntry(mappedId(entry.id))).map(entry => ({
      ...entry,
      id: mappedId(entry.id),
      parentId: entry.parentId ? mappedId(entry.parentId) : this.journal.rootId,
      ...(entry.type === 'compaction' ? { firstKeptEntryId: mappedId(entry.firstKeptEntryId) } : {}),
      ...(entry.type === 'label' || entry.type === 'context_edit' ? { targetId: mappedId(entry.targetId) } : {}),
      ...(entry.type === 'branch_summary' ? { fromId: mappedId(entry.fromId) } : {}),
    }))
    this.journal.appendEntries(imported)
    return this.journal.appendCheckpoint(run, position, endpoint ? mappedId(endpoint) : this.journal.rootId, true)
  }
}
