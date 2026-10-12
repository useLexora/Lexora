import type {
  Api,
  AssistantMessage,
  Model,
  UserMessage,
} from '@earendil-works/pi-ai'
import type { AttachmentService } from '../../../attachments/AttachmentService'
import type { ProviderExecutionModelResolver } from '../../../providers/ProviderExecutionModelResolver'
import type { ConversationHistoryRepository } from '../../../storage/conversationHistoryRepository'
import type { RunInputRepository } from '../../../storage/runInputRepository'
import type { RunRepository } from '../../../storage/runRepository'
import type { UsageRepository } from '../../../storage/usageRepository'
import { BuddyAgentRunError } from '../../../runs/runError'
import { readBuddyInputReference } from '../../context/BuddyInputReference'
import { isRejectedModelInput, rejectedBuddyInputMessage } from '../../context/prepareBuddyInputHistory'
import { createBuddyRecoveryMessages } from './createBuddyRecoveryMessages'

export type BuddySessionRecoveryPoint
  = | { kind: 'before_message', messageId: string }
    | { kind: 'after_message', messageId: string }
    | { kind: 'branch_head' }

export interface BuddySessionRecoveryResult {
  messages: Array<AssistantMessage | UserMessage>
  missingAttachmentIds: readonly string[]
  recoveredImageCount: number
}

export interface CreateBuddySessionRecoveryInput {
  branchId: string
  conversationId: string
  fallbackModel: Model<Api>
  point: BuddySessionRecoveryPoint
  threadId?: string
}

export interface BuddySessionRecoveryServiceOptions {
  attachments: Pick<AttachmentService, 'resolveRecoveryInputReferences'>
  conversations: Pick<ConversationHistoryRepository, 'listBranchMessages'>
  models: Pick<ProviderExecutionModelResolver, 'resolve'>
  runInputs: Pick<RunInputRepository, 'findByMessageId'>
  runs: Pick<RunRepository, 'findById'>
  usage: Pick<UsageRepository, 'listForRun'>
}

export class BuddySessionRecoveryService {
  readonly #options: BuddySessionRecoveryServiceOptions

  constructor(options: BuddySessionRecoveryServiceOptions) {
    this.#options = options
  }

  async create(input: CreateBuddySessionRecoveryInput): Promise<BuddySessionRecoveryResult> {
    const history = this.#options.conversations.listBranchMessages(
      input.conversationId,
      input.branchId,
    )
    const { point } = input
    const pointIndex = point.kind === 'branch_head' ? history.length : history.findIndex(message => message.id === point.messageId)
    if (pointIndex < 0)
      throw new BuddyAgentRunError('CONVERSATION_BINDING_MISMATCH')
    const boundary = pointIndex + (input.point.kind === 'after_message' ? 1 : 0)
    const messages = history.slice(0, boundary).filter((message) => {
      if (!input.threadId)
        return true
      const runId = message.role === 'user'
        ? this.#options.runInputs.findByMessageId(message.id)?.runId
        : message.runId
      return !!runId && this.#options.runs.findById(runId)?.threadId === input.threadId
    })
    const rejectedInputs = new Map<string, string>()

    const missingAttachmentIds = new Set<string>()
    const recoveredUserInputs = new Map<string, {
      attachmentIds?: string[]
      resourceLabels?: Record<string, string>
      documents: Awaited<ReturnType<AttachmentService['resolveRecoveryInputReferences']>>['documents']
      images: Awaited<ReturnType<AttachmentService['resolveRecoveryInputReferences']>>['images']
      prompt: string
    }>()
    let recoveredImageCount = 0
    for (const message of messages) {
      if (message.role !== 'user')
        continue
      const storedInput = this.#options.runInputs.findByMessageId(message.id)
      if (!storedInput)
        continue
      const run = this.#options.runs.findById(storedInput.runId)
      if (run?.status === 'failed' && isRejectedModelInput(run.errorCode)
        && !this.#options.usage.listForRun(run.id).some(record => record.totalTokens > 0)
        && !history.some(candidate => candidate.runId === run.id && (candidate.role === 'tool'
          || (candidate.role === 'assistant' && hasMessageText(candidate.content))))) {
        rejectedInputs.set(message.id, run.errorCode)
        recoveredUserInputs.set(message.id, { documents: [], images: [], prompt: storedInput.prompt })
        continue
      }
      const recovery = await this.#options.attachments.resolveRecoveryInputReferences(
        storedInput.attachmentIds,
        input.conversationId,
        storedInput.prompt,
      )
      recoveredImageCount += recovery.images.length
      for (const attachmentId of recovery.missingAttachmentIds)
        missingAttachmentIds.add(attachmentId)
      recoveredUserInputs.set(message.id, {
        attachmentIds: storedInput.attachmentIds.filter(id => !recovery.missingAttachmentIds.includes(id)),
        resourceLabels: recovery.resourceLabels,
        documents: recovery.documents,
        images: recovery.images,
        prompt: storedInput.prompt,
      })
    }

    return {
      messages: createBuddyRecoveryMessages({
        fallbackModel: input.fallbackModel,
        messages,
        resolveRunModel: runId => this.#resolveRunModel(runId),
        resolveUserInput: messageId => recoveredUserInputs.get(messageId) ?? null,
        triggeringMessageId: null,
      }).map((message) => {
        const reference = readBuddyInputReference(message)
        const code = reference && rejectedInputs.get(reference.messageId)
        return message.role === 'user' && code ? rejectedBuddyInputMessage(message, code) : message
      }),
      missingAttachmentIds: [...missingAttachmentIds],
      recoveredImageCount,
    }
  }

  #resolveRunModel(runId: string): Model<Api> | null {
    const run = this.#options.runs.findById(runId)
    if (!run)
      return null
    try {
      return this.#options.models.resolve({
        contextWindow: run.contextWindow,
        maxTokens: run.maxTokens,
        modelId: run.model,
        providerId: run.provider,
      })
    }
    catch {
      return null
    }
  }
}

function hasMessageText(content: unknown): boolean {
  if (typeof content === 'string')
    return content.trim().length > 0
  return content !== null && typeof content === 'object' && 'text' in content
    && typeof content.text === 'string' && content.text.trim().length > 0
}
