import type { BuddyComposerDraftSend } from '../../../shared/conversation/composerDraft'
import type { EventSnapshot } from '../../../shared/events/eventTypes'
import type { BuddyTurnLauncher } from '../agent/execution/BuddyTurnLauncher'
import type { ConversationLifecycleService } from '../conversations/ConversationLifecycleService'
import type { RunEventAvailability } from '../events/RunEventPorts'
import type {
  CommandRequestRecord,
  CommandRequestRepository,
  PrepareCommandRequestInput,
} from '../storage/commandRequestRepository'
import type { ComposerDraftCommitReceipt } from '../storage/commitComposerDraft'
import type { ComposerDraftRepository } from '../storage/composerDraftRepository'
import type { ConversationRepository } from '../storage/conversationRepository'
import type { RunRecord } from '../storage/runRecord'
import type { RunRepository } from '../storage/runRepository'
import type { SpaceRepository } from '../storage/spaceRepository'
import type { ChatInputSource } from './resolveChatInput'
import { randomUUID } from 'node:crypto'
import { parseBuddyChatCommand } from '../../../shared/conversation/buddyChatCommands'
import { buddyUserContentToText, getBuddyUserContentResourceIds } from '../../../shared/conversation/buddyUserContent'
import { Emitter } from '../../../shared/events/Emitter'
import { copyEventSnapshot } from '../../../shared/events/eventSnapshot'
import { AsyncOperationScope } from '../../../shared/lifecycle/AsyncOperationScope'
import { canonicalCommandJson } from '../commands/commandIntent'
import { BuddyServiceError } from '../rpc/runtimeRequest'
import { toPublicRun } from '../runs/publicRun'
import { requireActiveSpace } from '../spaces/requireActiveSpace'
import { resolveChatInput } from './resolveChatInput'

export type ExecuteChatCommandInput = BuddyComposerDraftSend

export type ChatCommandCommit = EventSnapshot<{
  commitId: string
  requestId: string
  conversationId: string
  branchId: string
  facts: [
    { kind: 'command.accepted', command: 'compact' },
    { kind: 'run.queued', runId: string, purpose: 'conversation.compaction' },
    ...({ kind: 'draft.consumed' } & ComposerDraftCommitReceipt)[],
  ]
}>

export interface ChatCommandServiceOptions {
  availability?: Pick<RunEventAvailability, 'assertConversationWritable'>
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
  readonly #operations = new AsyncOperationScope(() => this.#stopping.signal.reason)
  readonly onDidCommit: Emitter<ChatCommandCommit>['event']

  constructor(options: ChatCommandServiceOptions) {
    this.#options = options
    this.#committed = new Emitter(options.onObserverError ?? (() => {}))
    this.onDidCommit = this.#committed.event
  }

  get hasPendingOperations(): boolean {
    return this.#operations.hasPending
  }

  execute(input: ExecuteChatCommandInput): Promise<ReturnType<typeof toTurnStart>> {
    return this.#operations.track(() => this.#execute({ ...input }))
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

    const prepared = this.#options.commands.prepare(this.prepare(input))

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
        ...(prepared.draftReceipt ? [{ kind: 'draft.consumed' as const, ...prepared.draftReceipt }] : []),
      ],
    }))
    const operation = await this.#options.turnLauncher.launch(prepared.runId, this.#stopping.signal)
    void operation.completion.catch(() => {})
    return toTurnStart(prepared, this.#requireRun(operation.runId))
  }

  prepare(input: ChatInputSource & { requestId: string }): PrepareCommandRequestInput {
    this.#stopping.signal.throwIfAborted()
    const draft = resolveChatInput(input, this.#options.drafts)
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
      conversation.deletedAt !== null
      || conversation.approvalPolicy !== draft.executionConfig.approvalPolicy
      || conversation.executionProfile !== draft.executionConfig.executionProfile
      || this.#options.conversationLifecycle.isDeleting(conversation.id)
    ) {
      throw new BuddyServiceError('VALIDATION_FAILED')
    }
    if (conversation.spaceId)
      requireActiveSpace(this.#options.spaces.findById(conversation.spaceId))
    this.#options.availability?.assertConversationWritable(conversation.id)
    const runId = randomUUID()
    return {
      approvalPolicy: conversation.approvalPolicy,
      arguments: command.arguments,
      branchId: draft.scope.branchId,
      command: command.name,
      conversationId: conversation.id,
      createdAt: new Date().toISOString(),
      draft: draft.commit,
      executionProfile: conversation.executionProfile,
      requestFingerprint: createCommandFingerprint(input),
      requestId: input.requestId,
      runId,
    }
  }

  async dispose(): Promise<void> {
    this.#operations.stopAccepting()
    this.#stopping.abort()
    await this.#operations.drain()
    this.#committed.dispose()
  }

  #requireRun(runId: string): RunRecord {
    return requireValue(this.#options.runs.findById(runId))
  }
}

function createCommandFingerprint(input: ChatInputSource): string {
  return 'snapshot' in input ? canonicalCommandJson(input.snapshot) : `${input.draftId}:${input.expectedRevision}`
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
