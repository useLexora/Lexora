import type { AgentSession } from '@earendil-works/pi-coding-agent'
import type { BuddySessionRegistry } from '../agent/sessions/BuddySessionRegistry'
import type { ReusableBuddySession } from '../agent/sessions/ReusableBuddySession'
import type { BuddyConversationTree } from '../agent/sessions/tree/BuddyConversationTree'
import type { AttachmentService } from '../attachments/AttachmentService'
import type { ProviderExecutionModelResolver } from '../providers/ProviderExecutionModelResolver'
import type { AttachmentRecord } from '../storage/attachmentRepository'
import type { BuddyDataPaths } from '../storage/BuddyDataPaths'
import type { RunInputRepository } from '../storage/runInputRepository'
import type { RunRepository } from '../storage/runRepository'
import { Buffer } from 'node:buffer'
import { readBuddyInputReference } from '../agent/context/BuddyInputReference'
import { prepareBuddyInputHistory } from '../agent/context/prepareBuddyInputHistory'
import { projectMessageImages } from '../agent/context/projectBuddyInput'
import { PUBLIC_CONTEXT_TYPE } from '../agent/sessions/tree/BuddyPublicContext'
import { publicConversationMaterialSchema } from '../conversations/publicConversationContext'
import { assertModelInputBudget } from '../providers/modelInputBudget'
import { BuddyServiceError } from '../rpc/runtimeRequest'
import { actorThreadId } from '../storage/threadBindingRepository'

export type ChatInputHistoryPoint
  = | { kind: 'empty' }
    | { kind: 'branch_head' }
    | { kind: 'before_message', messageId: string }
    | { kind: 'after_run', runId: string, messageId: string }

export interface ChatInputValidationInput {
  actorId: string
  conversationId: string
  branchId: string
  point?: ChatInputHistoryPoint
  modelId: string
  providerId: string
  contextWindow: number | null
  maxTokens: number | null
  prompt: string
  attachments: readonly Pick<AttachmentRecord, 'mimeType' | 'sizeBytes'>[]
}

export interface ChatInputValidationServiceOptions {
  attachments: Pick<AttachmentService, 'getInputMetadata'>
  models: Pick<ProviderExecutionModelResolver, 'resolveAvailable'>
  paths: Pick<BuddyDataPaths, 'conversationWorkspace'>
  runInputs: Pick<RunInputRepository, 'findByTriggeringMessageId'>
  runs: Pick<RunRepository, 'findById'>
  sessions: Pick<BuddySessionRegistry<ReusableBuddySession>, 'getReady'>
  tree: Pick<BuddyConversationTree, 'snapshot' | 'preview'>
}

export class ChatInputValidationService {
  readonly #options: ChatInputValidationServiceOptions

  constructor(options: ChatInputValidationServiceOptions) {
    this.#options = options
  }

  async validate(input: ChatInputValidationInput): Promise<void> {
    const model = await this.#options.models.resolveAvailable(input)
    const currentBytes = input.attachments.length * 1024
    const context = await this.#readContext(input)
    let bytes = currentBytes + Buffer.byteLength(JSON.stringify(input.prompt), 'utf8')
    for (const message of prepareBuddyInputHistory(context.messages)) {
      const reference = readBuddyInputReference(message)
      if (!reference) {
        bytes += Buffer.byteLength(JSON.stringify(projectMessageImages(message, { ...model, input: ['text'] })), 'utf8')
        continue
      }
      const ids = reference.attachmentIds ?? [...reference.images, ...reference.documents ?? []].map(file => file.attachmentId)
      const records = this.#options.attachments.getInputMetadata(ids, input.conversationId)
      bytes += Buffer.byteLength(JSON.stringify(reference.prompt), 'utf8') + records.length * 1024
    }
    try {
      assertModelInputBudget(model, bytes)
    }
    catch {
      throw new BuddyServiceError('MODEL_INPUT_TOO_LARGE')
    }
  }

  async #readContext(input: ChatInputValidationInput): Promise<{ messages: AgentSession['messages'] }> {
    const point = input.point ?? { kind: 'branch_head' }
    if (point.kind === 'empty')
      return { messages: [] }
    const cwd = this.#options.paths.conversationWorkspace(input.conversationId)
    const threadId = actorThreadId(input.conversationId, input.actorId)
    if (point.kind === 'branch_head') {
      const active = this.#options.sessions.getReady(input.conversationId, input.branchId, input.actorId)?.getInputContext?.()
      const manager = await this.#options.tree.preview(input.conversationId, input.branchId, cwd, threadId)
      const preview = manager.buildSessionContext().messages
      if (!active)
        return { messages: preview }
      const represented = new Set(active.messages.flatMap(message => message.role === 'custom' && message.customType === PUBLIC_CONTEXT_TYPE ? [JSON.stringify(message.content)] : []))
      const inputs = new Set(active.messages.flatMap(message => readBuddyInputReference(message)?.messageId ?? []))
      const ownAnswers = new Set(active.messages.flatMap(message => message.role === 'assistant' ? [message.content.filter(part => part.type === 'text').map(part => part.text).join('')] : []))
      return { messages: [...active.messages, ...preview.filter((message) => {
        if (message.role !== 'custom' || message.customType !== PUBLIC_CONTEXT_TYPE || represented.has(JSON.stringify(message.content)))
          return false
        const material = publicConversationMaterialSchema.parse(message.details)
        return material.kind !== 'message' || !(inputs.has(material.messageId) || (material.actorId === input.actorId && material.role === 'assistant' && ownAnswers.has(material.text)))
      })] }
    }
    const sourceRunId = point.kind === 'after_run'
      ? point.runId
      : this.#options.runInputs.findByTriggeringMessageId(point.messageId)?.runId
    const run = sourceRunId ? this.#options.runs.findById(sourceRunId) : null
    const snapshot = run ? await this.#options.tree.snapshot(input.conversationId, run.branchId, cwd, run.id, point.kind === 'after_run' ? 'after' : 'before', threadId, point.messageId) : null
    if (snapshot)
      return { messages: snapshot.buildSessionContext().messages }
    throw new BuddyServiceError('VALIDATION_FAILED')
  }
}
