import type { DatabaseSync } from 'node:sqlite'
import type { ExecutionPhase } from '../../../shared/executions/executionApi'
import type { ExecutionBrief, ExecutionContextMode, ExecutionReview, ExecutionSubmission } from '../../../shared/executions/executionWork'
import type { ExecutionWorkRecord } from './executionWorkRepository'
import type { RunInputRecord } from './runInputRepository'
import type { RunRecord, RunStatus } from './runRecord'
import type { CreateRunInput } from './runRepository'
import { createHash } from 'node:crypto'
import { buddySettingsSchema } from '../../../shared/buddies/buddySettings'
import { executionMailboxMessageSchema } from '../../../shared/executions/executionApi'
import { executionReviewSchema, executionSubmissionSchema } from '../../../shared/executions/executionWork'
import { isExecutionProfileWithin } from '../../../shared/permissions/executionProfile'
import { buddyExecutionDefinitionSchema } from '../buddies/BuddyExecutionDefinition'
import { freezeConversationMemberModel } from './conversationMemberRepository'
import { createConversationPublicationRepository } from './conversationPublicationRepository'
import { withTransaction } from './database'
import { createExecutionPublicContext } from './executionPublicContext'
import { createExecutionWorkRepository } from './executionWorkRepository'
import { createRunInputRepository } from './runInputRepository'
import { createRunRepository } from './runRepository'
import { createThreadBindingRepository } from './threadBindingRepository'

export interface ExecutionStateRecord {
  work: ExecutionWorkRecord
  run: RunRecord
  phase: ExecutionPhase
  phaseVersion: number
  requestKey: string | null
  requestHash: string | null
  initialInput: Omit<RunInputRecord, 'runId' | 'createdAt'> | null
  admittedRootGeneration: number
  admittedParentGeneration: number
  resultMailboxId: string | null
  cancelRequestedAt: string | null
  cleanupState: 'pending' | 'clean' | 'degraded'
  cleanupErrorCode: string | null
  fileAccessCeiling: 'read_only' | null
}

export interface ExecutionFence {
  runId: string
  generation: number
  rootGeneration: number
  phaseVersion: number
}

export interface AdmitChildExecutionInput {
  callerId: string
  work?: { previousRunId?: string, contextMode: ExecutionContextMode, contextSourceIds: readonly string[], brief?: ExecutionBrief }
  authorization: { executionProfile: RunRecord['executionProfile'], approvalPolicy: RunRecord['approvalPolicy'], fileAccessCeiling?: 'read_only' }
  expectedCallerGeneration: number
  expectedRootGeneration: number
  requestKey: string
  requestHash: string
  resultMailboxId: string
  run: Omit<CreateRunInput, 'rootRunId' | 'parentRunId' | 'executionKind' | 'threadId' | 'generation' | 'status' | 'piSessionFile'> & {
    buddyId: string
    actorSnapshot: NonNullable<RunRecord['actorSnapshot']>
  }
  initialInput: Omit<RunInputRecord, 'runId' | 'createdAt'>
}

export const MAX_CHILD_ATTEMPTS_PER_ROOT = 64

export class ExecutionAdmissionError extends Error {
  readonly code: 'conflict' | 'stale' | 'unauthorized' | 'busy' | 'pending' | 'budget_exceeded' | 'input_forwarded' | 'forward_closed'

  constructor(code: ExecutionAdmissionError['code']) {
    super(`Execution admission ${code}`)
    this.code = code
    this.name = 'ExecutionAdmissionError'
  }
}

export function hashChildAdmissionRequest(input: Omit<AdmitChildExecutionInput, 'requestHash'>): string {
  return createHash('sha256').update(JSON.stringify({
    callerId: input.callerId,
    ...(input.work ? { work: input.work } : {}),
    authorization: input.authorization,
    conversationId: input.run.conversationId,
    branchId: input.run.branchId,
    actorSnapshot: input.run.actorSnapshot,
    initialInput: input.initialInput,
    approvalPolicy: input.run.approvalPolicy,
    executionProfile: input.run.executionProfile,
    executionContext: input.run.executionContext ?? null,
  })).digest('hex')
}

export function executionFence(record: ExecutionStateRecord, root: ExecutionStateRecord): ExecutionFence {
  return { runId: record.run.id, generation: record.run.generation, rootGeneration: root.run.generation, phaseVersion: record.phaseVersion }
}

export function createExecutionRepository(database: DatabaseSync) {
  const runs = createRunRepository(database)
  const threads = createThreadBindingRepository(database)
  const inputs = createRunInputRepository(database)
  const work = createExecutionWorkRepository(database)
  const publications = createConversationPublicationRepository(database)
  const publicContext = createExecutionPublicContext(database)

  function find(runId: string): ExecutionStateRecord | null {
    const run = runs.findById(runId)
    const row = database.prepare('SELECT * FROM execution_state WHERE run_id = ?').get(runId)
    if (!run || !row)
      return null
    const initial = inputs.findByRunId(runId)
    return {
      work: work.find(runId)!,
      run,
      phase: row.phase as ExecutionPhase,
      phaseVersion: row.phase_version as number,
      requestKey: row.request_key as string | null,
      requestHash: row.request_hash as string | null,
      initialInput: initial ? { prompt: initial.prompt, attachmentIds: initial.attachmentIds, contextItems: initial.contextItems, reasoning: initial.reasoning, serviceTier: initial.serviceTier } : null,
      admittedRootGeneration: row.admitted_root_generation as number,
      admittedParentGeneration: row.admitted_parent_generation as number,
      resultMailboxId: row.result_mailbox_id as string | null,
      cancelRequestedAt: row.cancel_requested_at as string | null,
      cleanupState: row.cleanup_state as ExecutionStateRecord['cleanupState'],
      cleanupErrorCode: row.cleanup_error_code as string | null,
      fileAccessCeiling: row.file_access_ceiling as 'read_only' | null,
    }
  }

  function requireRecord(runId: string): ExecutionStateRecord {
    const record = find(runId)
    if (!record)
      throw new ExecutionAdmissionError('stale')
    return record
  }

  function ancestors(record: ExecutionStateRecord): ExecutionStateRecord[] {
    const result: ExecutionStateRecord[] = []
    const visited = new Set<string>()
    let next: ExecutionStateRecord | null = record
    while (next) {
      if (visited.has(next.run.id))
        throw new ExecutionAdmissionError('conflict')
      visited.add(next.run.id)
      result.push(next)
      next = next.run.parentRunId ? requireRecord(next.run.parentRunId) : null
    }
    if (result.at(-1)?.run.id !== record.run.rootRunId)
      throw new ExecutionAdmissionError('conflict')
    return result
  }

  function isOpen(record: ExecutionStateRecord): boolean {
    return (record.run.status === 'queued' || record.run.status === 'running')
      && record.phase !== 'closing' && record.phase !== 'closed' && !record.cancelRequestedAt
  }

  function assertLive(record: ExecutionStateRecord): ExecutionStateRecord[] {
    const chain = ancestors(record)
    const conversation = database.prepare('SELECT active_branch_id, deleted_at FROM conversations WHERE id = ?').get(record.run.conversationId)
    if (!conversation || conversation.deleted_at !== null || conversation.active_branch_id !== record.run.branchId || chain.some(item => !isOpen(item)))
      throw new ExecutionAdmissionError('stale')
    for (let index = 0; index < chain.length - 1; index++) {
      if (chain[index]!.admittedParentGeneration !== chain[index + 1]!.run.generation || chain[index]!.admittedRootGeneration !== chain.at(-1)!.run.generation)
        throw new ExecutionAdmissionError('stale')
    }
    return chain
  }

  function assertFence(fence: ExecutionFence, live = true): ExecutionStateRecord {
    const record = requireRecord(fence.runId)
    const root = requireRecord(record.run.rootRunId)
    if (record.run.generation !== fence.generation || record.phaseVersion !== fence.phaseVersion || root.run.generation !== fence.rootGeneration)
      throw new ExecutionAdmissionError('stale')
    if (live)
      assertLive(record)
    return record
  }

  function listTree(rootRunId: string): ExecutionStateRecord[] {
    return runs.listTree(rootRunId).map(run => requireRecord(run.id))
  }

  function descendants(runId: string): string[] {
    return (database.prepare(`WITH RECURSIVE subtree(id) AS (
      SELECT id FROM runs WHERE id = ? UNION ALL SELECT runs.id FROM runs JOIN subtree ON runs.parent_run_id = subtree.id
    ) SELECT id FROM subtree`).all(runId) as { id: string }[]).map(row => row.id)
  }

  function setPhase(record: ExecutionStateRecord, phase: ExecutionPhase): ExecutionStateRecord {
    database.prepare('UPDATE execution_state SET phase = ?, phase_version = phase_version + 1 WHERE run_id = ? AND phase_version = ?')
      .run(phase, record.run.id, record.phaseVersion)
    return requireRecord(record.run.id)
  }

  function contextBoundary(record: ExecutionStateRecord): number {
    const accepted = database.prepare(`SELECT MAX(publications.sequence) AS sequence FROM chat_queue queue
      JOIN conversation_publications publications ON publications.message_id = json_extract(queue.prepared_json, '$.userMessageId')
      WHERE queue.run_id = ? AND queue.state = 'sent'`).get(record.run.id)?.sequence
    return Math.max(publications.getPublicSnapshot(record.run.id), Number(accepted ?? 0))
  }

  function listAttachments(runId: string): string[] {
    const record = requireRecord(runId)
    return (database.prepare(`SELECT DISTINCT attachment.value AS id FROM execution_work_attempts work
      JOIN run_inputs input ON input.run_id = work.run_id, json_each(input.attachment_ids_json) attachment
      WHERE work.work_id = ?
      UNION SELECT attachment.value AS id FROM execution_work_attempts work
      JOIN chat_queue queue ON queue.run_id = work.run_id, json_each(queue.prepared_json, '$.runInput.attachmentIds') attachment
      WHERE work.work_id = ? AND queue.state = 'sent'`).all(record.work.workId, record.work.workId) as { id: string }[]).map(row => row.id)
  }

  function assertNoForwardFallback(callerId: string, actorId: string): void {
    const latestInput = publicContext.findForwardGuardInput(callerId)
    if (!latestInput)
      return
    const forwarded = database.prepare(`SELECT mailbox.payload_json FROM execution_mailbox_sources mailbox
      JOIN runs target ON target.id = mailbox.target_run_id
      WHERE mailbox.id = ? AND target.buddy_id = ?`).get(latestInput.messageId, actorId)
    const message = forwarded && executionMailboxMessageSchema.safeParse(JSON.parse(forwarded.payload_json as string))
    if (message && message.success && publicContext.isForwardedInput(message.data))
      throw new ExecutionAdmissionError('input_forwarded')
  }

  function publicCaller(runId: string): ExecutionStateRecord {
    const caller = requireRecord(runId)
    if (caller.run.actorSnapshot?.kind !== 'actor' || !['root', 'actor_child'].includes(caller.run.executionKind))
      throw new ExecutionAdmissionError('unauthorized')
    return caller
  }

  function requirePublicWork(callerId: string, runId: string): ExecutionStateRecord {
    const caller = publicCaller(callerId)
    if (!publicContext.hasWork(caller.run, contextBoundary(caller), runId))
      throw new ExecutionAdmissionError('unauthorized')
    return requireRecord(runId)
  }

  function summarizePublicWork(caller: ExecutionStateRecord, record: ExecutionStateRecord) {
    return {
      runId: record.run.id,
      rootRunId: record.run.rootRunId,
      workId: record.work.workId,
      actorId: record.run.buddyId,
      phase: record.phase,
      status: record.run.status,
      errorCode: record.run.errorCode,
      task: publicContext.readTask(record.run, contextBoundary(caller)),
    }
  }

  return {
    find,
    listAttachments,
    assertNoForwardFallback,
    requirePublicWork,
    isForwardedPublicInput: publicContext.isForwardedInput,
    listAcceptedUserInputs(runId: string, offset = 0, limit = 13) {
      publicCaller(runId)
      return publicContext.listInputs(runId, offset, limit)
    },
    findForwardGuardInput(runId: string) {
      publicCaller(runId)
      return publicContext.findForwardGuardInput(runId)
    },
    findAcceptedUserInput(runId: string, sourceId: string) {
      publicCaller(runId)
      return publicContext.findInput(runId, sourceId)
    },
    listPublicWork(runId: string, offset = 0, limit = 13) {
      const caller = publicCaller(runId)
      return publicContext.listWorks(caller.run, contextBoundary(caller), offset, limit)
        .map(row => summarizePublicWork(caller, requireRecord(row.id)))
    },
    readPublicWork(callerId: string, runId: string) {
      const record = requirePublicWork(callerId, runId)
      return { work: summarizePublicWork(publicCaller(callerId), record), reply: publicContext.readReply(record.run) }
    },
    assertCurrent(fence: ExecutionFence): ExecutionStateRecord {
      return assertFence(fence)
    },
    listTree,
    submit(runId: string, value: ExecutionSubmission) {
      return withTransaction(database, () => {
        const record = requireRecord(runId)
        assertLive(record)
        if (!['working', 'waiting'].includes(record.phase))
          throw new ExecutionAdmissionError('stale')
        const submission = executionSubmissionSchema.parse(value)
        database.prepare('UPDATE execution_work_attempts SET submission_json = ? WHERE run_id = ?').run(JSON.stringify(submission), runId)
        return work.find(runId)!
      })
    },
    review(callerId: string, runId: string, value: ExecutionReview) {
      return withTransaction(database, () => {
        const caller = requireRecord(callerId)
        assertLive(caller)
        const record = requireRecord(runId)
        const owner = record.run.parentRunId ? requireRecord(record.run.parentRunId) : null
        if (!owner || owner.run.buddyId !== caller.run.buddyId || caller.run.actorSnapshot?.kind !== 'actor'
          || record.run.conversationId !== caller.run.conversationId || record.run.branchId !== caller.run.branchId) {
          throw new ExecutionAdmissionError('unauthorized')
        }
        if (record.phase !== 'closed' || record.cleanupState !== 'clean' || work.successor(runId))
          throw new ExecutionAdmissionError('stale')
        const review = executionReviewSchema.parse(value)
        if (review.verdict === 'accepted' && record.run.status !== 'completed')
          throw new ExecutionAdmissionError('conflict')
        if (record.work.review && JSON.stringify(record.work.review) !== JSON.stringify(review))
          throw new ExecutionAdmissionError('conflict')
        database.prepare('UPDATE execution_work_attempts SET review_json = ? WHERE run_id = ?').run(JSON.stringify(review), runId)
        return work.find(runId)!
      })
    },
    listOwnedWork(runId: string, offset = 0, limit = 64) {
      const caller = requireRecord(runId)
      return (database.prepare(`SELECT child.id FROM runs child JOIN runs parent ON parent.id = child.parent_run_id
        WHERE child.conversation_id = ? AND child.branch_id = ? AND parent.buddy_id = ?
          AND NOT EXISTS (SELECT 1 FROM execution_work_attempts next WHERE next.previous_run_id = child.id)
        ORDER BY child.started_at DESC, child.id DESC LIMIT ? OFFSET ?`).all(caller.run.conversationId, caller.run.branchId, caller.run.buddyId, limit, offset) as { id: string }[]).map(row => requireRecord(row.id))
    },
    listContext(runId: string) {
      const caller = requireRecord(runId)
      return publications.listPublications(caller.run.conversationId, caller.run.branchId, contextBoundary(caller))
    },
    listUnfinishedTree(rootRunId: string): ExecutionStateRecord[] {
      return listTree(rootRunId).filter(record => record.phase !== 'closed' || record.cleanupState !== 'clean')
    },
    admitChild(input: AdmitChildExecutionInput): { execution: ExecutionStateRecord, created: boolean } {
      return withTransaction(database, () => {
        if (!input.requestKey || input.requestHash !== hashChildAdmissionRequest(input))
          throw new ExecutionAdmissionError('conflict')
        const requestKey = JSON.stringify([input.callerId, input.requestKey])
        const existing = database.prepare('SELECT run_id, request_hash FROM execution_state WHERE request_key = ?').get(requestKey)
        if (existing) {
          if (existing.request_hash !== input.requestHash)
            throw new ExecutionAdmissionError('conflict')
          return { execution: requireRecord(existing.run_id as string), created: false }
        }
        const caller = requireRecord(input.callerId)
        const chain = assertLive(caller)
        const root = chain.at(-1)!
        if (caller.run.generation !== input.expectedCallerGeneration || root.run.generation !== input.expectedRootGeneration
          || !['working', 'waiting'].includes(caller.phase) || caller.run.executionKind === 'maintenance'
          || input.run.conversationId !== caller.run.conversationId || input.run.branchId !== caller.run.branchId
          || input.run.purpose !== caller.run.purpose) {
          throw new ExecutionAdmissionError('stale')
        }
        if (listTree(root.run.id).length - 1 >= MAX_CHILD_ATTEMPTS_PER_ROOT)
          throw new ExecutionAdmissionError('budget_exceeded')
        const snapshot = buddyExecutionDefinitionSchema.parse(input.run.actorSnapshot)
        const target = database.prepare('SELECT kind, revision, enabled, deleted_at, settings_json FROM buddies WHERE id = ?').get(input.run.buddyId)
        if (!target || target.enabled !== 1 || target.deleted_at !== null || target.revision !== snapshot.revision
          || target.kind !== snapshot.kind || JSON.stringify(buddySettingsSchema.parse(JSON.parse(target.settings_json as string))) !== JSON.stringify(snapshot.settings) || snapshot.id !== input.run.buddyId
          || input.run.provider !== snapshot.model.providerId || input.run.model !== snapshot.model.modelId
          || input.initialInput.reasoning !== snapshot.model.reasoning || input.initialInput.serviceTier !== snapshot.model.serviceTier
          || !caller.run.actorSnapshot || caller.run.actorSnapshot.kind !== 'actor') {
          throw new ExecutionAdmissionError('unauthorized')
        }
        assertNoForwardFallback(caller.run.id, snapshot.id)
        if (snapshot.kind === 'actor' && !database.prepare('SELECT 1 FROM conversation_members WHERE conversation_id = ? AND actor_id = ? AND removed_at IS NULL').get(caller.run.conversationId, snapshot.id))
          throw new ExecutionAdmissionError('unauthorized')
        if (snapshot.kind === 'npc') {
          const currentCaller = database.prepare('SELECT settings_json FROM buddies WHERE id = ?').get(caller.run.buddyId)
          if (!currentCaller || !buddySettingsSchema.parse(JSON.parse(currentCaller.settings_json as string)).npcTeamEnabled
            || !caller.run.actorSnapshot.settings.npcIds.includes(snapshot.id)) {
            throw new ExecutionAdmissionError('unauthorized')
          }
        }
        const context = input.work ?? { contextMode: snapshot.kind === 'npc' ? 'isolated' as const : 'conversation' as const, contextSourceIds: [] }
        const previous = context.previousRunId ? requireRecord(context.previousRunId) : null
        const ceiling = previous?.fileAccessCeiling === 'read_only' || previous?.run.executionProfile === 'read_only' || input.authorization.fileAccessCeiling === 'read_only' || chain.some(ancestor => ancestor.fileAccessCeiling === 'read_only' || ancestor.run.actorSnapshot?.settings.limits.fileAccess === 'read_only')
          || snapshot.settings.limits.fileAccess === 'read_only'
        if (!isExecutionProfileWithin(input.run.executionProfile, input.authorization.executionProfile)
          || (input.authorization.approvalPolicy === 'manual' && input.run.approvalPolicy !== 'manual')
          || (ceiling && input.run.executionProfile !== 'read_only')) {
          throw new ExecutionAdmissionError('unauthorized')
        }
        if (snapshot.kind === 'actor' && database.prepare(`SELECT 1 FROM runs JOIN execution_state ON execution_state.run_id = runs.id
          JOIN execution_threads ON execution_threads.id = runs.thread_id
          WHERE execution_threads.conversation_id = ? AND execution_threads.actor_id = ? AND execution_threads.kind = 'actor'
            AND execution_state.phase <> 'closed' LIMIT 1`).get(caller.run.conversationId, snapshot.id)) {
          throw new ExecutionAdmissionError('busy')
        }
        if (database.prepare('SELECT 1 FROM execution_state WHERE result_mailbox_id = ?').get(input.resultMailboxId))
          throw new ExecutionAdmissionError('conflict')
        if (previous) {
          const owner = previous.run.parentRunId ? requireRecord(previous.run.parentRunId) : null
          if (!owner || owner.run.buddyId !== caller.run.buddyId || previous.run.conversationId !== caller.run.conversationId
            || previous.run.branchId !== caller.run.branchId || previous.run.buddyId !== snapshot.id
            || previous.phase !== 'closed' || previous.cleanupState !== 'clean' || work.successor(previous.run.id)
            || context.contextMode !== previous.work.contextMode) {
            throw new ExecutionAdmissionError('stale')
          }
        }
        const availableAttachments = new Set([...listAttachments(caller.run.id), ...(previous ? listAttachments(previous.run.id) : [])])
        if (input.initialInput.attachmentIds.some(id => !availableAttachments.has(id)))
          throw new ExecutionAdmissionError('unauthorized')
        const availableSources = new Set(publications.listPublications(caller.run.conversationId, caller.run.branchId, contextBoundary(caller)).map(material => material.sourceId))
        if (context.contextSourceIds.some(id => !availableSources.has(id)))
          throw new ExecutionAdmissionError('unauthorized')
        if (snapshot.kind === 'actor')
          freezeConversationMemberModel(database, caller.run.conversationId, snapshot.id, snapshot.model)
        const threadId = previous?.run.threadId ?? (snapshot.kind === 'actor' && context.contextMode === 'conversation'
          ? threads.ensureActor(caller.run.conversationId, snapshot.id, input.run.startedAt).id
          : threads.createIsolated(caller.run.conversationId, snapshot.id, snapshot.kind, input.run.startedAt).id)
        const piSessionFile = threads.findPreviousSession(threadId, input.run.branchId)
        const run = runs.create({ ...input.run, actorSnapshot: snapshot, status: 'queued', piSessionFile, rootRunId: root.run.id, parentRunId: caller.run.id, executionKind: snapshot.kind === 'npc' ? 'npc_child' : 'actor_child', threadId, generation: 0 })
        work.configure(run.id, context)
        if (context.contextSourceIds.length || context.contextMode === 'conversation')
          database.prepare('UPDATE run_public_snapshots SET public_sequence = ? WHERE run_id = ?').run(contextBoundary(caller), run.id)
        database.prepare(`UPDATE execution_state SET request_key = ?, request_hash = ?,
          admitted_root_generation = ?, admitted_parent_generation = ?, result_mailbox_id = ?, file_access_ceiling = ? WHERE run_id = ?`)
          .run(requestKey, input.requestHash, root.run.generation, caller.run.generation, input.resultMailboxId, ceiling ? 'read_only' : null, run.id)
        database.prepare('INSERT INTO run_inputs (run_id, prompt, attachment_ids_json, context_items_json, reasoning, service_tier, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(run.id, input.initialInput.prompt, JSON.stringify(input.initialInput.attachmentIds), JSON.stringify(input.initialInput.contextItems), snapshot.model.reasoning, snapshot.model.serviceTier, run.startedAt)
        return { execution: requireRecord(run.id), created: true }
      })
    },
    beginPreparing(fence: ExecutionFence): ExecutionStateRecord {
      return withTransaction(database, () => {
        const record = assertFence(fence)
        if (record.phase !== 'queued')
          throw new ExecutionAdmissionError('stale')
        return setPhase(record, 'preparing')
      })
    },
    claimWorking(fence: ExecutionFence): ExecutionStateRecord {
      return withTransaction(database, () => {
        const record = assertFence(fence)
        if (!['queued', 'preparing', 'waiting'].includes(record.phase))
          throw new ExecutionAdmissionError('stale')
        if (database.prepare('SELECT 1 FROM runs JOIN execution_state ON execution_state.run_id = runs.id WHERE thread_id = ? AND phase = \'working\' AND runs.id <> ?').get(record.run.threadId, record.run.id))
          throw new ExecutionAdmissionError('busy')
        if (record.run.executionKind === 'npc_child') {
          for (const ancestor of ancestors(record).slice(1)) {
            const cap = ancestor.run.actorSnapshot?.settings.npcConcurrency
            if (ancestor.run.actorSnapshot?.kind !== 'actor' || cap?.mode !== 'limited')
              continue
            const ids = descendants(ancestor.run.id)
            const working = database.prepare(`SELECT COUNT(*) AS count FROM runs JOIN execution_state ON execution_state.run_id = runs.id
              WHERE runs.id IN (${ids.map(() => '?').join(',')}) AND execution_kind = 'npc_child' AND phase = 'working'`).get(...ids)!.count as number
            if (working >= cap.limit)
              throw new ExecutionAdmissionError('busy')
          }
        }
        setPhase(record, 'working')
        return requireRecord(record.run.id)
      })
    },
    markWaiting(fence: ExecutionFence): ExecutionStateRecord {
      return withTransaction(database, () => {
        const record = assertFence(fence)
        if (record.phase !== 'working')
          throw new ExecutionAdmissionError('stale')
        return setPhase(record, 'waiting')
      })
    },
    beginClosing(fence: ExecutionFence, mode: 'success' | 'failure' | 'cancel'): ExecutionStateRecord {
      return withTransaction(database, () => {
        const record = assertFence(fence, false)
        if (record.phase === 'closed' || record.phase === 'closing')
          throw new ExecutionAdmissionError('stale')
        if (mode === 'success') {
          assertLive(record)
          if (database.prepare(`SELECT 1 FROM execution_mailbox_sources question WHERE source_run_id = ? AND json_extract(question.payload_json, '$.kind') = 'question'
            AND NOT EXISTS (SELECT 1 FROM execution_mailbox_sources answer WHERE json_extract(answer.payload_json, '$.kind') = 'answer'
              AND json_extract(answer.payload_json, '$.questionId') = json_extract(question.payload_json, '$.questionId')) LIMIT 1`).get(record.run.id)) {
            throw new ExecutionAdmissionError('pending')
          }
          const children = database.prepare('SELECT runs.status, execution_state.phase, execution_state.cleanup_state, result_mailbox_id FROM runs JOIN execution_state ON execution_state.run_id = runs.id WHERE parent_run_id = ?').all(record.run.id)
          if (children.some(child => child.phase !== 'closed' || child.cleanup_state === 'pending' || (child.status !== 'cancelled' && child.result_mailbox_id
            && !database.prepare('SELECT 1 FROM execution_mailbox_receipts WHERE mailbox_id = ? AND target_run_id = ? AND kind = \'consumed\'').get(child.result_mailbox_id as string, record.run.id)))) {
            throw new ExecutionAdmissionError('pending')
          }
          if (database.prepare(`SELECT 1 FROM execution_mailbox_sources source WHERE target_run_id = ? AND target_generation = ?
            AND NOT (json_extract(source.payload_json, '$.kind') = 'question' AND COALESCE(json_extract(source.payload_json, '$.audience'), 'caller') = 'user')
            AND NOT EXISTS (SELECT 1 FROM execution_mailbox_receipts WHERE mailbox_id = source.id AND kind IN ('consumed', 'rejected')) LIMIT 1`).get(record.run.id, record.run.generation)) {
            throw new ExecutionAdmissionError('pending')
          }
        }
        database.prepare('UPDATE runs SET generation = generation + 1 WHERE id = ? AND generation = ?').run(record.run.id, fence.generation)
        return setPhase(record, 'closing')
      })
    },
    finishClosing(fence: ExecutionFence, status: Extract<RunStatus, 'completed' | 'failed' | 'cancelled'>, completedAt: string, errorCode: string | null): ExecutionStateRecord {
      return withTransaction(database, () => {
        const record = assertFence(fence, false)
        if (record.phase !== 'closing')
          throw new ExecutionAdmissionError('stale')
        database.prepare('UPDATE runs SET status = ?, completed_at = ?, error_code = ? WHERE id = ?').run(status, completedAt, errorCode, record.run.id)
        return requireRecord(record.run.id)
      })
    },
    requestCancel(runId: string, now: string): ExecutionStateRecord[] {
      return withTransaction(database, () => {
        const record = requireRecord(runId)
        const ids = descendants(runId)
        if (record.phase !== 'closed' && !record.cancelRequestedAt)
          database.prepare('UPDATE runs SET generation = generation + 1 WHERE id = ?').run(runId)
        for (const id of ids) {
          database.prepare('UPDATE execution_state SET cancel_requested_at = COALESCE(cancel_requested_at, ?), phase_version = phase_version + CASE WHEN cancel_requested_at IS NULL THEN 1 ELSE 0 END WHERE run_id = ? AND phase <> \'closed\'')
            .run(now, id)
        }
        return ids.map(requireRecord)
      })
    },
    setFileAccessCeiling(runId: string): ExecutionStateRecord {
      database.prepare('UPDATE execution_state SET file_access_ceiling = \'read_only\' WHERE run_id = ?').run(runId)
      return requireRecord(runId)
    },
    recordCleanup(runId: string, state: 'clean' | 'degraded', errorCode: string | null): ExecutionStateRecord {
      database.prepare('UPDATE execution_state SET cleanup_state = ?, cleanup_error_code = ? WHERE run_id = ?').run(state, errorCode, runId)
      return requireRecord(runId)
    },
  }
}

export type ExecutionRepository = ReturnType<typeof createExecutionRepository>
