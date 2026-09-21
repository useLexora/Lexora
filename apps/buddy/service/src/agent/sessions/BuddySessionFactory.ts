import type { BuddyThinkingLevel } from '../../../../shared/conversation/modelSelection'
import type { RuntimePreferences } from '../../../../shared/runtime/runtimePreferences'
import type { ProviderExecutionModelResolver } from '../../providers/ProviderExecutionModelResolver'
import type { ConversationRepository } from '../../storage/conversationRepository'
import type { RunRepository } from '../../storage/runRepository'
import type { BuddySessionExtensionServices } from '../extensions/createBuddySessionExtensions'
import type { BuddySessionBlueprint } from './BuddySessionBlueprint'
import type { BuddyConversationTree } from './tree/BuddyConversationTree'
import { ApplicationEvents } from '../../../../shared/observability/ApplicationEvents'
import { isExecutionProfileWithin } from '../../../../shared/permissions/executionProfile'
import { AttachmentToolWorkspace } from '../../attachments/AttachmentToolWorkspace'
import { BuddyAgentRunError } from '../../runs/runError'
import { createBuddySessionExtensions } from '../extensions/createBuddySessionExtensions'
import { createBuddySession } from './createBuddySession'
import { createReusableBuddySession } from './createReusableBuddySession'

export interface BuddySessionFactoryOptions {
  bindPreferences?: (apply: (preferences: RuntimePreferences) => void) => Promise<() => void>
  tree: BuddyConversationTree
  events?: ApplicationEvents
  agentDirectory: string
  conversations: Pick<ConversationRepository, 'findById'>
  conversationsDirectory: string
  models: Pick<
    ProviderExecutionModelResolver,
    'resolveAvailable' | 'resolveSession'
  >
  runs: Pick<RunRepository, 'findById'>
  services: BuddySessionExtensionServices
}

export interface BuddySessionFactoryInput {
  blueprint: BuddySessionBlueprint
  piSessionFile: string | null
  runId: string
  signal: AbortSignal
  thinkingLevel?: BuddyThinkingLevel
}

export class BuddySessionFactory {
  readonly #options: BuddySessionFactoryOptions

  constructor(options: BuddySessionFactoryOptions) {
    this.#options = options
  }

  async create(input: BuddySessionFactoryInput) {
    const { blueprint } = input
    const events = (this.#options.events ?? new ApplicationEvents()).scope({
      component: 'runtime.pi',
      conversationId: blueprint.conversationId,
      branchId: blueprint.branchId,
      runId: input.runId,
      sessionId: crypto.randomUUID(),
    })
    return events.operation('session.open', scoped => this.#create(input, scoped))
  }

  async #create(input: BuddySessionFactoryInput, events: ApplicationEvents) {
    const { blueprint } = input
    const run = this.#options.runs.findById(input.runId)
    const conversation = this.#options.conversations.findById(blueprint.conversationId)
    const expectedSessionMode = run?.purpose === 'automation'
      ? 'automation_background'
      : 'interactive'
    if (
      !run
      || run.status !== 'running'
      || !conversation
      || conversation.deletedAt !== null
      || conversation.activeBranchId !== blueprint.branchId
      || conversation.id !== run.conversationId
      || conversation.spaceId !== (blueprint.space?.id ?? null)
      || conversation.approvalPolicy !== blueprint.approvalPolicy
      || !isExecutionProfileWithin(blueprint.executionProfile, conversation.executionProfile)
      || run.branchId !== blueprint.branchId
      || run.approvalPolicy !== blueprint.approvalPolicy
      || run.executionProfile !== blueprint.executionProfile
      || run.piSessionFile !== input.piSessionFile
      || !blueprint.grants.some(grant => grant.canonicalRoot === blueprint.canonicalRoot)
      || !blueprint.grants.some(grant => grant.canonicalRoot === blueprint.scratchRoot)
      || blueprint.sessionMode !== expectedSessionMode
    ) {
      throw new BuddyAgentRunError('CONVERSATION_BINDING_MISMATCH')
    }

    const selected = await this.#options.models.resolveSession({
      contextWindow: run.contextWindow,
      maxTokens: run.maxTokens,
      modelId: run.model,
      providerId: run.provider,
    })
    const extensions = await events.operation('session.resources', async () => {
      await this.#options.services.prepareForRun?.(input.signal)
      return createBuddySessionExtensions({
        approvalPolicy: blueprint.approvalPolicy,
        canonicalRoot: blueprint.canonicalRoot,
        conversationId: blueprint.conversationId,
        executionProfile: blueprint.executionProfile,
        grants: blueprint.grants,
        skillReadRoots: blueprint.resources.skillReadRoots,
        sessionMode: blueprint.sessionMode,
        signal: input.signal,
        spaceId: blueprint.space?.id ?? null,
        services: this.#options.services,
      })
    })
    const tree = await this.#options.tree.open(run, blueprint.canonicalRoot, selected.model)
    let reusable: ReturnType<typeof createReusableBuddySession> | undefined
    const session = await createBuddySession({
      getInputMessages: () => reusable?.getInputContext?.().messages ?? [],
      sessionManager: tree.manager,
      agentDir: this.#options.agentDirectory,
      approvalPolicy: blueprint.approvalPolicy,
      branchId: blueprint.branchId,
      canonicalRoot: blueprint.canonicalRoot,
      conversationsDirectory: this.#options.conversationsDirectory,
      conversationId: blueprint.conversationId,
      cwd: blueprint.canonicalRoot,
      executionProfile: blueprint.executionProfile,
      getServiceTier: extensions.getServiceTier,
      getPendingInput: () => extensions.inputReferences.pending,
      inProcessExtensions: extensions.inProcessExtensions,
      model: selected.model,
      modelRuntime: selected.runtime,
      resources: blueprint.resources,
      thinkingLevel: input.thinkingLevel,
    })

    const inputWorkspace = new AttachmentToolWorkspace(blueprint.scratchRoot)
    let unsubscribePreferences: (() => void) | undefined
    reusable = createReusableBuddySession({
      skillReferences: blueprint.resources.skillReferences,
      tree,
      assertModelAccess: async (provider, model, contextWindow, maxTokens) => {
        return this.#options.models.resolveAvailable({
          contextWindow,
          maxTokens,
          modelId: model,
          providerId: provider,
        })
      },
      runContext: extensions.runContext,
      session: session.session,
      shutdown: (reason) => {
        unsubscribePreferences?.()
        return events.scope({ runId: undefined, operationId: undefined, parentOperationId: undefined }).operation('session.close', () => session.shutdown(reason))
      },
      inputReferences: extensions.inputReferences,
      getInputMetadata: ids => this.#options.services.attachmentService.getInputMetadata(ids, blueprint.conversationId),
      materializeDocuments: input => this.#options.services.attachmentService.materializeDocumentInputs(
        input.documents ?? [],
        blueprint.conversationId,
      ),
      materializeInput: async (input) => {
        const resources = await this.#options.services.attachmentService.materializeInputResources(input, blueprint.conversationId, inputWorkspace)
        return [
          { text: input.prompt, type: 'text' as const },
          ...resources ? [{ text: resources, type: 'text' as const }] : [],
          ...(await this.#options.services.attachmentService.materializePiInputImages(
            input.images,
            blueprint.conversationId,
          )).flatMap((image, index) => [
            { type: 'text' as const, text: `Native attachment: ${input.images[index]!.attachmentId}` },
            image,
          ]),
        ]
      },
    })
    try {
      unsubscribePreferences = await this.#options.bindPreferences?.(reusable.applyPreferences)
    }
    catch (error) {
      await reusable.shutdown('quit')
      throw error
    }
    return {
      piSessionFile: session.piSessionFile,
      recoveredFromProductHistory: tree.recoveredFromProductHistory,
      recoveryDegradation: tree.recoveryDegradation,
      session: reusable,
    }
  }
}
