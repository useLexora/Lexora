import type { AgentSession } from '@earendil-works/pi-coding-agent'
import type { BuddySessionRegistry } from '../agent/sessions/BuddySessionRegistry'
import type { BuddySessionRecoveryService } from '../agent/sessions/recovery/BuddySessionRecoveryService'
import type { ReusableBuddySession } from '../agent/sessions/ReusableBuddySession'
import type { BuddyConversationTree } from '../agent/sessions/tree/BuddyConversationTree'
import type { AttachmentService } from '../attachments/AttachmentService'
import type { InputModel } from '../providers/modelCapabilities'
import type { ProviderExecutionModelResolver } from '../providers/ProviderExecutionModelResolver'
import type { AttachmentRecord } from '../storage/attachmentRepository'
import type { BuddyDataPaths } from '../storage/BuddyDataPaths'
import type { RunInputRepository } from '../storage/runInputRepository'
import type { RunRepository } from '../storage/runRepository'
import { Buffer } from 'node:buffer'
import { readBuddyInputReference } from '../agent/context/BuddyInputReference'
import { prepareBuddyInputHistory } from '../agent/context/prepareBuddyInputHistory'
import { projectMessageImages } from '../agent/context/projectBuddyInput'
import { assertModelInputBudget } from '../providers/modelInputBudget'
import { BuddyServiceError } from '../rpc/runtimeRequest'

export type ChatInputHistoryPoint
  = | { kind: 'empty' }
    | { kind: 'branch_head' }
    | { kind: 'before_message', messageId: string }
    | { kind: 'after_run', runId: string, messageId: string }

export interface ChatInputValidationInput {
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
  recovery: Pick<BuddySessionRecoveryService, 'create'>
  runInputs: Pick<RunInputRepository, 'findByTriggeringMessageId'>
  runs: Pick<RunRepository, 'findById' | 'findLatestForBranch'>
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
    const context = await this.#readContext(input, model)
    let bytes = currentBytes + Buffer.byteLength(JSON.stringify(input.prompt), 'utf8')
    for (const message of prepareBuddyInputHistory(context.messages)) {
      const reference = readBuddyInputReference(message)
      if (!reference) {
        bytes += Buffer.byteLength(JSON.stringify(projectMessageImages(message, model)), 'utf8')
        continue
      }
      const ids = reference.attachmentIds ?? [...reference.images, ...reference.documents ?? []].map(file => file.attachmentId)
      const records = this.#options.attachments.getInputMetadata(ids, input.conversationId)
      bytes += Buffer.byteLength(JSON.stringify(reference.prompt), 'utf8') + records.length * 1024
    }
    try {
      assertModelInputBudget(model.api, bytes)
    }
    catch {
      throw new BuddyServiceError('MODEL_INPUT_TOO_LARGE')
    }
  }

  async #readContext(input: ChatInputValidationInput, model: InputModel): Promise<{ messages: AgentSession['messages'] }> {
    const point = input.point ?? { kind: 'branch_head' }
    if (point.kind === 'empty')
      return { messages: [] }
    const cwd = this.#options.paths.conversationWorkspace(input.conversationId)
    if (point.kind === 'branch_head') {
      const active = this.#options.sessions.getReady(input.conversationId, input.branchId)?.getInputContext?.()
      if (active)
        return active
      const latest = this.#options.runs.findLatestForBranch(input.conversationId, input.branchId)
      const manager = await this.#options.tree.preview(input.conversationId, input.branchId, cwd, model, latest?.piSessionFile ?? null)
      return { messages: manager.buildSessionContext().messages }
    }
    const sourceRunId = point.kind === 'after_run'
      ? point.runId
      : this.#options.runInputs.findByTriggeringMessageId(point.messageId)?.runId
    const run = sourceRunId ? this.#options.runs.findById(sourceRunId) : null
    const snapshot = run ? await this.#options.tree.snapshot(input.conversationId, run.branchId, cwd, run.id, point.kind === 'after_run' ? 'after' : 'before') : null
    if (snapshot)
      return { messages: snapshot.buildSessionContext().messages }
    return this.#options.recovery.create({
      conversationId: input.conversationId,
      branchId: input.branchId,
      fallbackModel: model,
      point: { kind: point.kind === 'after_run' ? 'after_message' : 'before_message', messageId: point.messageId },
    })
  }
}
