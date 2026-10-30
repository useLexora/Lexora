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
import type { BuddyDefinitionResolver } from '../buddies/BuddyDefinitionResolver'
import type { RunEventReader } from '../events/RunEventPorts'
import type { ProviderExecutionModelResolver } from '../providers/ProviderExecutionModelResolver'
import type { BuddyDataPaths } from '../storage/BuddyDataPaths'
import type { ComposerDraftRepository } from '../storage/composerDraftRepository'
import type { ConversationHistoryRepository } from '../storage/conversationHistoryRepository'
import type { ConversationRepository } from '../storage/conversationRepository'
import type { RunRepository } from '../storage/runRepository'
import type { ThreadBindingRepository } from '../storage/threadBindingRepository'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import { contextUsageSnapshotSchema } from '../../../shared/conversation/contextApi'
import { DEFAULT_RUNTIME_PREFERENCES } from '../../../shared/runtime/runtimePreferences'
import { createBuddySessionExtensions } from '../agent/extensions/createBuddySessionExtensions'
import { createBuddyContextSnapshot } from '../agent/sessions/createBuddySession'
import { BuddyServiceError } from '../rpc/runtimeRequest'
import { actorThreadId } from '../storage/threadBindingRepository'

export interface ContextUsageModelSelection {
  modelId: string
  providerId: string
  reasoning: BuddyThinkingLevel | null
  serviceTier: BuddyServiceTier | null
}

export interface ContextUsageSnapshotInput {
  actorId?: string
  runId?: string
  approvalPolicy: BuddyApprovalPolicy
  branchId: string | null
  conversationId: string | null
  draftId: string
  executionProfile: BuddyExecutionProfile
  modelSelection: ContextUsageModelSelection
  spaceId: string | null
}

export interface ContextUsageSnapshotServiceOptions {
  runs: Pick<RunRepository, 'findById'>
  threads: Pick<ThreadBindingRepository, 'find'>
  events: Pick<RunEventReader, 'findLatest'>
  definitions: Pick<BuddyDefinitionResolver, 'capture'>
  getDefaultActorId: () => string
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

    const targetRun = input.runId ? this.#requireRun(input) : null
    if (targetRun && followup && (source?.runId !== targetRun.id || source.branchId !== input.branchId))
      throw new BuddyServiceError('VALIDATION_FAILED')
    const selected = await this.#options.models.resolveSession({
      contextWindow: null,
      maxTokens: null,
      modelId: input.modelSelection.modelId,
      providerId: input.modelSelection.providerId,
    })
    const identity = {
      contextWindow: selected.model.contextWindow,
      createdAt: new Date().toISOString(),
      modelId: selected.model.id,
      providerId: selected.model.provider,
    }
    if (targetRun) {
      const latest = await this.#options.events.findLatest(targetRun.id, ['context.usage.updated', 'context.compaction.completed'])
      if (this.#requireRun(input).threadId !== targetRun.threadId)
        throw new BuddyServiceError('VALIDATION_FAILED')
      if (latest?.type !== 'context.usage.updated' || latest.runId !== targetRun.id)
        return { ...identity, status: 'pending' }
      const payload = latest.payload as Record<string, unknown> | null
      if (payload?.model !== identity.modelId || payload.provider !== identity.providerId)
        return { ...identity, status: 'pending' }
      const snapshot = contextUsageSnapshotSchema.safeParse({
        ...identity,
        createdAt: latest.createdAt,
        status: 'ready',
        mcpTokens: payload.mcpTokens,
        messageTokens: payload.messageTokens,
        skillTokens: payload.skillTokens,
        systemPromptTokens: payload.systemPromptTokens,
        toolTokens: payload.toolTokens,
        totalTokens: payload.totalTokens,
      })
      return snapshot.success ? snapshot.data : { ...identity, status: 'pending' }
    }
    const actorId = input.actorId ?? conversation?.buddyId ?? this.#options.getDefaultActorId()
    const actor = (await this.#options.definitions.capture({ buddyId: actorId, kind: 'actor', conversationId: conversation?.id ?? null, requestedModel: input.modelSelection })).definition
    const threadId = conversation ? actorThreadId(conversation.id, actorId) : undefined
    const approvalPolicy = conversation?.approvalPolicy ?? input.approvalPolicy
    const executionProfile = conversation?.executionProfile ?? input.executionProfile
    const branchId = followup?.branchId ?? input.branchId ?? 'context-preview'
    const blueprint = conversation
      ? await this.#options.blueprints.createForConversation({
          approvalPolicy,
          branchId,
          conversationId: conversation.id,
          threadId,
          actor,
          executionProfile,
          spaceId: conversation.spaceId,
          sessionMode: 'interactive',
        })
      : await this.#options.blueprints.createForDraft({
          approvalPolicy,
          draftId: input.draftId,
          actor,
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
      toolScope: actor.settings.tools,
      fileAccessLimit: actor.settings.limits.fileAccess,
      sessionMode: blueprint.sessionMode,
      signal: new AbortController().signal,
      spaceId: blueprint.space?.id ?? null,
      services: this.#options.sessionExtensionServices,
    })
    try {
      extensions.setCodemodeEnabled(runtimePreferences?.codemode ?? DEFAULT_RUNTIME_PREFERENCES.codemode)
      const sessionManager = conversation
        ? followup
          ? await this.#options.tree.snapshot(conversation.id, branchId, blueprint.canonicalRoot, source!.runId!, 'after', threadId!, source!.id)
          : await this.#options.tree.preview(conversation.id, branchId, blueprint.canonicalRoot, threadId!)
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
    finally {
      await extensions.dispose()
    }
  }

  #requireRun(input: ContextUsageSnapshotInput) {
    const run = input.runId ? this.#options.runs.findById(input.runId) : null
    const conversation = input.conversationId ? this.#options.conversations.findById(input.conversationId) : null
    const thread = run ? this.#options.threads.find(run.threadId) : null
    if (!run || !conversation || !input.actorId
      || conversation.deletedAt !== null
      || conversation.spaceId !== input.spaceId
      || conversation.approvalPolicy !== input.approvalPolicy
      || conversation.executionProfile !== input.executionProfile
      || run.conversationId !== input.conversationId || run.branchId !== input.branchId || run.buddyId !== input.actorId
      || (run.executionKind !== 'root' && run.executionKind !== 'actor_child')
      || thread?.conversationId !== input.conversationId || thread.actorId !== input.actorId || thread.kind !== 'actor') {
      throw new BuddyServiceError('VALIDATION_FAILED')
    }
    return run
  }
}
