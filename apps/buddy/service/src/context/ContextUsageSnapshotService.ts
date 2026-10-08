import type {
  BuddyServiceTier,
  BuddyThinkingLevel,
} from '../../../shared/conversation/modelSelection'
import type { BuddyApprovalPolicy } from '../../../shared/permissions/approvalPolicy'
import type { BuddyExecutionProfile } from '../../../shared/permissions/executionProfile'
import type { RuntimePreferences } from '../../../shared/runtime/runtimePreferences'
import type { BuddySessionExtensionServices } from '../agent/extensions/createBuddySessionExtensions'
import type { BuddySessionBlueprintService } from '../agent/sessions/BuddySessionBlueprintService'
import type { BuddyContextSnapshot } from '../agent/sessions/createBuddySession'
import type { BuddyConversationTree } from '../agent/sessions/tree/BuddyConversationTree'
import type { ProviderExecutionModelResolver } from '../providers/ProviderExecutionModelResolver'
import type { BuddyDataPaths } from '../storage/BuddyDataPaths'
import type { ComposerDraftRepository } from '../storage/composerDraftRepository'
import type { ConversationHistoryRepository } from '../storage/conversationHistoryRepository'
import type { ConversationRepository } from '../storage/conversationRepository'
import type { RunRepository } from '../storage/runRepository'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import { createBuddySessionExtensions } from '../agent/extensions/createBuddySessionExtensions'
import { createBuddyContextSnapshot } from '../agent/sessions/createBuddySession'
import { BuddyServiceError } from '../rpc/runtimeRequest'

export interface ContextUsageModelSelection {
  modelId: string
  providerId: string
  reasoning: BuddyThinkingLevel | null
  serviceTier: BuddyServiceTier | null
}

export interface ContextUsageSnapshotInput {
  approvalPolicy: BuddyApprovalPolicy
  branchId: string | null
  conversationId: string | null
  draftId: string
  executionProfile: BuddyExecutionProfile
  modelSelection: ContextUsageModelSelection
  spaceId: string | null
}

export interface ContextUsageSnapshotServiceOptions {
  getRuntimePreferences?: () => Promise<RuntimePreferences>
  tree: BuddyConversationTree
  drafts: Pick<ComposerDraftRepository, 'findById'>
  agentDirectory: string
  blueprints: Pick<
    BuddySessionBlueprintService,
    'createForConversation' | 'createForDraft'
  >
  conversations: Pick<ConversationRepository, 'findById'>
    & Pick<ConversationHistoryRepository, 'listBranches' | 'findMessageById'>
  models: Pick<ProviderExecutionModelResolver, 'resolveSession'>
  paths: Pick<BuddyDataPaths, 'conversationsDirectory'>
  runs: Pick<RunRepository, 'findLatestForBranch'>
  sessionExtensionServices: BuddySessionExtensionServices
}

type ReadyBuddyContextSnapshot = Exclude<BuddyContextSnapshot, null>

export type ContextUsageSnapshot = {
  contextWindow: number
  createdAt: string
  modelId: string
  providerId: string
} & (
  | { status: 'pending' }
  | ReadyBuddyContextSnapshot & { status: 'ready' }
)

export interface ContextUsageSnapshotReader {
  getSnapshot: (input: ContextUsageSnapshotInput) => Promise<ContextUsageSnapshot>
}

export class ContextUsageSnapshotService implements ContextUsageSnapshotReader {
  readonly #options: ContextUsageSnapshotServiceOptions

  constructor(options: ContextUsageSnapshotServiceOptions) {
    this.#options = options
  }

  async getSnapshot(input: ContextUsageSnapshotInput): Promise<ContextUsageSnapshot> {
    const scope = this.#options.drafts.findById(input.draftId)?.scope
    const followup = scope?.kind === 'message_followup' ? scope : null
    const source = followup ? this.#options.conversations.findMessageById(followup.assistantMessageId) : null
    if (followup && (followup.conversationId !== input.conversationId
      || !source?.runId || source.role !== 'assistant' || source.branchId !== followup.branchId
      || source.conversationId !== followup.conversationId)) {
      throw new BuddyServiceError('VALIDATION_FAILED')
    }
    const conversation = input.conversationId
      ? this.#options.conversations.findById(input.conversationId)
      : null
    if (input.conversationId && !conversation)
      throw new BuddyServiceError('VALIDATION_FAILED')
    if (
      conversation
      && (
        conversation.deletedAt !== null
        || conversation.spaceId !== input.spaceId
        || conversation.approvalPolicy !== input.approvalPolicy
        || conversation.executionProfile !== input.executionProfile
        || !input.branchId
        || !this.#options.conversations.listBranches(conversation.id).some(
          branch => branch.id === input.branchId,
        )
      )
    ) {
      throw new BuddyServiceError('VALIDATION_FAILED')
    }

    const approvalPolicy = conversation?.approvalPolicy ?? input.approvalPolicy
    const executionProfile = conversation?.executionProfile ?? input.executionProfile
    const selected = await this.#options.models.resolveSession({
      contextWindow: null,
      maxTokens: null,
      modelId: input.modelSelection.modelId,
      providerId: input.modelSelection.providerId,
    })
    const branchId = followup?.branchId ?? input.branchId ?? 'context-preview'
    const latestRun = conversation
      ? this.#options.runs.findLatestForBranch(conversation.id, branchId)
      : null
    const blueprint = conversation
      ? await this.#options.blueprints.createForConversation({
          approvalPolicy,
          branchId,
          conversationId: conversation.id,
          executionProfile,
          spaceId: conversation.spaceId,
          sessionMode: 'interactive',
        })
      : await this.#options.blueprints.createForDraft({
          approvalPolicy,
          draftId: input.draftId,
          executionProfile,
          spaceId: input.spaceId,
        })
    const runtimePreferences = await this.#options.getRuntimePreferences?.()
    const extensions = await createBuddySessionExtensions({
      approvalPolicy: blueprint.approvalPolicy,
      canonicalRoot: blueprint.canonicalRoot,
      conversationId: blueprint.conversationId,
      executionProfile: blueprint.executionProfile,
      grants: blueprint.grants,
      skillReadRoots: blueprint.resources.skillReadRoots,
      sessionMode: blueprint.sessionMode,
      signal: new AbortController().signal,
      spaceId: blueprint.space?.id ?? null,
      services: this.#options.sessionExtensionServices,
    })
    extensions.setCodemodeEnabled(runtimePreferences?.codemode ?? false)
    const identity = {
      contextWindow: selected.model.contextWindow,
      createdAt: new Date().toISOString(),
      modelId: selected.model.id,
      providerId: selected.model.provider,
    }
    const sessionManager = conversation
      ? followup
        ? await this.#options.tree.snapshot(conversation.id, branchId, blueprint.canonicalRoot, source!.runId!)
        : await this.#options.tree.preview(conversation.id, branchId, blueprint.canonicalRoot, selected.model, latestRun?.piSessionFile ?? null)
      : SessionManager.inMemory(blueprint.canonicalRoot)
    if (!sessionManager)
      return { ...identity, status: 'pending' }
    const snapshot = await createBuddyContextSnapshot({
      sessionManager,
      agentDir: this.#options.agentDirectory,
      approvalPolicy: blueprint.approvalPolicy,
      branchId: blueprint.branchId,
      canonicalRoot: blueprint.canonicalRoot,
      conversationsDirectory: this.#options.paths.conversationsDirectory,
      conversationId: blueprint.conversationId,
      cwd: blueprint.canonicalRoot,
      executionProfile: blueprint.executionProfile,
      getServiceTier: extensions.getServiceTier,
      inProcessExtensions: extensions.inProcessExtensions,
      model: selected.model,
      modelRuntime: selected.runtime,
      resources: blueprint.resources,
      thinkingLevel: input.modelSelection.reasoning ?? undefined,
    })
    if (!snapshot)
      return { ...identity, status: 'pending' }

    return {
      ...snapshot,
      ...identity,
      status: 'ready',
    }
  }
}
