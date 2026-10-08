import type { BuddyComposerDraftSend } from '../../../shared/conversation/composerDraft'
import type { EventSnapshot } from '../../../shared/events/eventTypes'
import type { BuddyTurnLauncher } from '../agent/execution/BuddyTurnLauncher'
import type { ConversationLifecycleService } from '../conversations/ConversationLifecycleService'
import type {
  CommandRequestRecord,
  CommandRequestRepository,
} from '../storage/commandRequestRepository'
import type { ComposerDraftCommitReceipt } from '../storage/commitComposerDraft'
import type { ComposerDraftRepository } from '../storage/composerDraftRepository'
import type { ConversationRepository } from '../storage/conversationRepository'
import type { RunRecord } from '../storage/runRecord'
import type { RunRepository } from '../storage/runRepository'
import type { SpaceRepository } from '../storage/spaceRepository'
import { randomUUID } from 'node:crypto'
import { parseBuddyChatCommand } from '../../../shared/conversation/buddyChatCommands'
import { buddyUserContentToText, getBuddyUserContentResourceIds } from '../../../shared/conversation/buddyUserContent'
import { Emitter } from '../../../shared/events/Emitter'
import { copyEventSnapshot } from '../../../shared/events/eventSnapshot'
import { BuddyServiceError } from '../rpc/runtimeRequest'
import { toPublicRun } from '../runs/publicRun'
import { requireActiveSpace } from '../spaces/requireActiveSpace'

export type ExecuteChatCommandInput = BuddyComposerDraftSend

export type ChatCommandCommit = EventSnapshot<{
  commitId: string
  requestId: string
  conversationId: string
  branchId: string
  facts: [
    { kind: 'command.accepted', command: 'compact' },
    { kind: 'run.queued', runId: string, purpose: 'conversation.compaction' },
    { kind: 'draft.consumed' } & ComposerDraftCommitReceipt,
  ]
}>

export interface ChatCommandServiceOptions {
  commands: CommandRequestRepository
  conversationLifecycle: Pick<ConversationLifecycleService, 'isDeleting'>
  conversations: Pick<ConversationRepository, 'findById'>
  drafts: Pick<ComposerDraftRepository, 'findById'>
  spaces: Pick<SpaceRepository, 'findById'>
  runs: Pick<RunRepository, 'findById'>
  turnLauncher: Pick<BuddyTurnLauncher, 'launch'>
  onObserverError?: (error: unknown) => void
}

export class ChatCommandService {
  readonly #options: ChatCommandServiceOptions
  readonly #committed: Emitter<ChatCommandCommit>
  readonly #stopping = new AbortController()
  readonly #pending = new Set<Promise<unknown>>()
  readonly onDidCommit: Emitter<ChatCommandCommit>['event']

  constructor(options: ChatCommandServiceOptions) {
    this.#options = options
    this.#committed = new Emitter(options.onObserverError ?? (() => {}))
    this.onDidCommit = this.#committed.event
  }

  execute(input: ExecuteChatCommandInput): Promise<ReturnType<typeof toTurnStart>> {
    const pending = Promise.withResolvers<ReturnType<typeof toTurnStart>>()
    this.#pending.add(pending.promise)
    void this.#execute({ ...input }).then((value) => {
      this.#pending.delete(pending.promise)
      pending.resolve(value)
    }, (error) => {
      this.#pending.delete(pending.promise)
      pending.reject(error)
    })
    return pending.promise
  }

  async #execute(input: ExecuteChatCommandInput) {
    this.#stopping.signal.throwIfAborted()
    const requestFingerprint = createCommandFingerprint(input)
    const replay = this.#options.commands.findByRequestId(input.requestId)
    const replayRun = replay ? this.#requireRun(replay.runId) : null
    if (replay) {
      if (replay.requestFingerprint !== requestFingerprint)
        throw new BuddyServiceError('VALIDATION_FAILED')
      return toTurnStart(replay, requireValue(replayRun))
    }

    const draft = requireValue(this.#options.drafts.findById(input.draftId), 'DRAFT_CONFLICT')
    if (draft.revision !== input.expectedRevision)
      throw new BuddyServiceError('DRAFT_CONFLICT')
    if (draft.scope.kind !== 'conversation_branch')
      throw new BuddyServiceError('VALIDATION_FAILED')
    const content = buddyUserContentToText(draft.content).trim()
    const command = parseBuddyChatCommand(content)
    const directives = draft.content.body.flatMap(paragraph => paragraph.content.filter(
      node => node.type === 'prompt_directive' && node.directive === 'slash_command',
    ))
    if (
      !command
      || command.name !== 'compact'
      || getBuddyUserContentResourceIds(draft.content).length
      || draft.content.quotes?.length
      || draft.content.resourceQuotes?.length
      || draft.content.sessionReferences?.length
      || directives.length !== 1
      || directives[0]?.commandMode !== 'action'
      || directives[0].commandId
      || directives[0].value !== `/${command.name}`
    ) {
      throw new BuddyServiceError('VALIDATION_FAILED')
    }
    const conversation = requireValue(
      this.#options.conversations.findById(draft.scope.conversationId),
    )
    if (
      conversation.activeBranchId !== draft.scope.branchId
      || conversation.approvalPolicy !== draft.executionConfig.approvalPolicy
      || conversation.executionProfile !== draft.executionConfig.executionProfile
      || this.#options.conversationLifecycle.isDeleting(conversation.id)
    ) {
      throw new BuddyServiceError('VALIDATION_FAILED')
    }
    if (conversation.spaceId)
      requireActiveSpace(this.#options.spaces.findById(conversation.spaceId))
    const runId = randomUUID()
    const prepared = this.#options.commands.prepare({
      approvalPolicy: conversation.approvalPolicy,
      arguments: command.arguments,
      branchId: draft.scope.branchId,
      command: command.name,
      conversationId: conversation.id,
      createdAt: new Date().toISOString(),
      draft: { draftId: draft.draftId, expectedRevision: input.expectedRevision },
      executionProfile: conversation.executionProfile,
      requestFingerprint,
      requestId: input.requestId,
      runId,
    })
    if (!prepared.created)
      return toTurnStart(prepared, this.#requireRun(prepared.runId))

    this.#committed.fire(copyEventSnapshot({
      commitId: prepared.runId,
      requestId: prepared.requestId,
      conversationId: prepared.conversationId,
      branchId: prepared.branchId,
      facts: [
        { kind: 'command.accepted', command: prepared.command },
        { kind: 'run.queued', runId: prepared.runId, purpose: 'conversation.compaction' },
        { kind: 'draft.consumed', ...prepared.draftReceipt },
      ],
    }))
    const operation = await this.#options.turnLauncher.launch(prepared.runId, this.#stopping.signal)
    void operation.completion.catch(() => {})
    return toTurnStart(prepared, this.#requireRun(operation.runId))
  }

  async dispose(): Promise<void> {
    this.#stopping.abort()
    await Promise.allSettled(this.#pending)
    this.#committed.dispose()
  }

  #requireRun(runId: string): RunRecord {
    return requireValue(this.#options.runs.findById(runId))
  }
}

function createCommandFingerprint(input: ExecuteChatCommandInput): string {
  return `${input.draftId}:${input.expectedRevision}`
}

function toTurnStart(request: CommandRequestRecord, run: RunRecord) {
  return {
    branchId: request.branchId,
    conversationId: request.conversationId,
    draftReceipt: request.draftReceipt,
    run: toPublicRun(run, null),
    runId: request.runId,
  }
}

function requireValue<T>(value: T | null, code: 'DRAFT_CONFLICT' | 'VALIDATION_FAILED' = 'VALIDATION_FAILED'): T {
  if (value === null)
    throw new BuddyServiceError(code)
  return value
}
