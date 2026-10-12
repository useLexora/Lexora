import type { BuddyThinkingLevel } from '../../../../shared/conversation/modelSelection'
import type { BuddyExecutionProfile } from '../../../../shared/permissions/executionProfile'
import type { BuddyPermissionSettings } from '../../../../shared/permissions/permissionMode'
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
  getRunPermissionCeiling: (runId: string) => BuddyExecutionProfile | undefined
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

    const effectiveModel = run.modelOverride ?? run.actorSnapshot?.model
    const changedModel = effectiveModel && (effectiveModel.providerId !== run.provider || effectiveModel.modelId !== run.model)
    const selected = await this.#options.models.resolveSession({
      contextWindow: changedModel ? null : run.contextWindow,
      maxTokens: changedModel ? null : run.maxTokens,
      modelId: effectiveModel?.modelId ?? run.model,
      providerId: effectiveModel?.providerId ?? run.provider,
    })
    const extensions = await events.operation('session.resources', async () => {
      if (run.purpose !== 'conversation.compaction')
        await this.#options.services.prepareForRun?.(input.signal)
      return createBuddySessionExtensions({
        actorKind: blueprint.actor?.kind,
        toolScope: run.purpose === 'conversation.compaction' ? { mode: 'none' } : blueprint.actor?.settings.tools,
        fileAccessLimit: this.#options.getRunPermissionCeiling(run.id) === 'read_only' ? 'read_only' : blueprint.actor?.settings.limits.fileAccess,
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
    try {
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
        getPermissionSettings: extensions.getPermissionSettings,
        getPendingInput: () => extensions.inputReferences.pending,
        inProcessExtensions: extensions.inProcessExtensions,
        model: selected.model,
        modelRuntime: selected.runtime,
        resources: blueprint.resources,
        thinkingLevel: input.thinkingLevel,
      })

      const inputWorkspace = new AttachmentToolWorkspace(blueprint.scratchRoot)
      let unsubscribePreferences: (() => void) | undefined
      let runPermissionCeiling: BuddyExecutionProfile | undefined
      const restrictPermissions = (settings: BuddyPermissionSettings): BuddyPermissionSettings => ({
        ...settings,
        executionProfile: runPermissionCeiling === 'read_only' || blueprint.actor?.settings.limits.fileAccess === 'read_only'
          ? 'read_only'
          : settings.executionProfile,
      })
      reusable = createReusableBuddySession({
        getModelSelection: async () => {
          while (true) {
            const activeRun = this.#options.runs.findById(extensions.runContext.current?.runId ?? run.id)
            const readSelection = () => {
              const currentRun = this.#options.runs.findById(activeRun?.id ?? run.id)
              return currentRun?.modelOverride ?? currentRun?.actorSnapshot?.model ?? blueprint.actor?.model
            }
            const selection = readSelection()
            if (!selection)
              return null
            const model = await this.#options.models.resolveAvailable({ providerId: selection.providerId, modelId: selection.modelId, contextWindow: null, maxTokens: null })
            if (JSON.stringify(readSelection()) !== JSON.stringify(selection))
              continue
            return {
              provider: selection.providerId,
              model: selection.modelId,
              contextWindow: model.contextWindow,
              maxTokens: model.maxTokens,
              thinkingLevel: selection.reasoning ?? undefined,
              serviceTier: selection.serviceTier,
            }
          }
        },
        getPermissionSettings: (runId) => {
          runPermissionCeiling = this.#options.getRunPermissionCeiling(runId)
          const current = this.#options.conversations.findById(blueprint.conversationId)
          return restrictPermissions(current && (current.approvalPolicy !== conversation.approvalPolicy || current.executionProfile !== conversation.executionProfile)
            ? current
            : { approvalPolicy: blueprint.approvalPolicy, executionProfile: blueprint.executionProfile })
        },
        updatePermissionSettings: settings => extensions.updatePermissionSettings(restrictPermissions(settings)),
        setCodemodeEnabled: extensions.setCodemodeEnabled,
        skillReferences: blueprint.resources.availableSkillReferences ?? blueprint.resources.skillReferences,
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
          return events.scope({ runId: undefined, operationId: undefined, parentOperationId: undefined }).operation('session.close', async () => {
            const results = await Promise.allSettled([extensions.dispose(), session.shutdown(reason)])
            const failures = results.filter(result => result.status === 'rejected')
            if (failures.length)
              throw new AggregateError(failures.map(result => result.reason), 'SESSION_CLOSE_FAILED')
          })
        },
        inputReferences: extensions.inputReferences,
        getInputMetadata: ids => this.#options.services.attachmentService.getInputMetadata(ids, blueprint.conversationId),
        prepareInputImages: (images, model) => this.#options.services.attachmentService.prepareInputImages(images, blueprint.conversationId, model),
        materializeDocuments: input => this.#options.services.attachmentService.materializeDocumentInputs(
          input.documents ?? [],
          blueprint.conversationId,
        ),
        materializeInput: async (input, images) => {
          const resources = await this.#options.services.attachmentService.materializeInputResources(input, blueprint.conversationId, inputWorkspace)
          return [
            { text: input.prompt, type: 'text' as const },
            ...resources ? [{ text: resources, type: 'text' as const }] : [],
            ...input.images.flatMap((reference) => {
              const prepared = images?.get(reference.attachmentId)
              if (!prepared)
                throw new Error('RESOURCE_MATERIALIZATION_FAILED')
              return [
                { type: 'text' as const, text: `Native attachment: ${reference.attachmentId}${prepared.note ? `\n${prepared.note}` : ''}` },
                prepared.image,
              ]
            }),
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
        resourceRevisions: extensions.resourceRevisions,
        recoveredFromProductHistory: tree.recoveredFromProductHistory,
        recoveryDegradation: tree.recoveryDegradation,
        session: reusable,
      }
    }
    catch (error) {
      try {
        await extensions.dispose()
      }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], 'SESSION_INITIALIZATION_FAILED') }
      throw error
    }
  }
}
