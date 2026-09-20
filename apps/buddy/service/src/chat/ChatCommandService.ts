import type { BuddyComposerDraftSend } from '../../../shared/conversation/composerDraft'
import type { BuddyTurnLauncher } from '../agent/execution/BuddyTurnLauncher'
import type { ConversationLifecycleService } from '../conversations/ConversationLifecycleService'
import type {
  CommandRequestRecord,
  CommandRequestRepository,
} from '../storage/commandRequestRepository'
import type { ComposerDraftRepository } from '../storage/composerDraftRepository'
import type { ConversationRepository } from '../storage/conversationRepository'
import type { RunRecord } from '../storage/runRecord'
import type { RunRepository } from '../storage/runRepository'
import type { SpaceRepository } from '../storage/spaceRepository'
import { randomUUID } from 'node:crypto'
import { parseBuddyChatCommand } from '../../../shared/conversation/buddyChatCommands'
import { buddyUserContentToText, getBuddyUserContentResourceIds } from '../../../shared/conversation/buddyUserContent'
import { BuddyServiceError } from '../rpc/runtimeRequest'
import { toPublicRun } from '../runs/publicRun'
import { requireActiveSpace } from '../spaces/requireActiveSpace'

export type ExecuteChatCommandInput = BuddyComposerDraftSend

export interface ChatCommandServiceOptions {
  commands: CommandRequestRepository
  conversationLifecycle: Pick<ConversationLifecycleService, 'isDeleting'>
  conversations: Pick<ConversationRepository, 'findById'>
  drafts: Pick<ComposerDraftRepository, 'findById'>
  spaces: Pick<SpaceRepository, 'findById'>
  runs: Pick<RunRepository, 'findById'>
  turnLauncher: Pick<BuddyTurnLauncher, 'launch'>
}

export class ChatCommandService {
  readonly #options: ChatCommandServiceOptions

  constructor(options: ChatCommandServiceOptions) {
    this.#options = options
  }

  async execute(input: ExecuteChatCommandInput) {
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
      || directives.length !== 1
      || directives[0]?.commandMode !== 'action'
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

    const operation = await this.#options.turnLauncher.launch(prepared.runId)
    void operation.completion
    return toTurnStart(prepared, this.#requireRun(operation.runId))
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
