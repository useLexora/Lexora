import type { AttachmentService } from '../../attachments/AttachmentService'
import type { BuddyDefinitionResolver } from '../../buddies/BuddyDefinitionResolver'
import type { ProviderExecutionModelResolver } from '../../providers/ProviderExecutionModelResolver'
import type { SkillService } from '../../skills/SkillService'
import type { CommandRequestRepository } from '../../storage/commandRequestRepository'
import type { ConversationRepository } from '../../storage/conversationRepository'
import type { RunInputRepository } from '../../storage/runInputRepository'
import type { RunRepository } from '../../storage/runRepository'
import type { BuddySessionBlueprintService } from '../sessions/BuddySessionBlueprintService'
import type {
  StartBuddyCompactionInput,
  StartBuddyTurnInput,
} from './turnTypes'
import { BuddyAgentRunError } from '../../runs/runError'
import { SkillError } from '../../skills/skillFiles'
import { createBuddyInputReference } from '../context/BuddyInputReference'
import { recoverRunActorSnapshot } from '../sessions/recovery/recoverRunActorSnapshot'

export type BuddyRunExecutionPlan
  = | { input: StartBuddyTurnInput, kind: 'turn' }
    | { input: StartBuddyCompactionInput, kind: 'compaction' }

export interface BuddyRunExecutionPlannerOptions {
  getFileAccessCeiling?: (runId: string) => 'read_only' | undefined
  definitions: Pick<BuddyDefinitionResolver, 'resolve'>
  attachments: Pick<AttachmentService, 'resolveInputReferences'>
  commands: Pick<CommandRequestRepository, 'findByRunId'>
  conversations: Pick<ConversationRepository, 'findById'>
  models: Pick<ProviderExecutionModelResolver, 'resolveAvailable'>
  runInputs: Pick<RunInputRepository, 'findByRunId'>
  runs: Pick<RunRepository, 'findById' | 'setActorSnapshot'>
  sessions: Pick<BuddySessionBlueprintService, 'createForConversation'>
  skills: Pick<SkillService, 'materializeForSpace'>
}

export class BuddyRunExecutionPlanner {
  readonly #options: BuddyRunExecutionPlannerOptions

  constructor(options: BuddyRunExecutionPlannerOptions) {
    this.#options = options
  }

  async resolve(runId: string): Promise<BuddyRunExecutionPlan> {
    const run = this.#options.runs.findById(runId)
    if (!run)
      throw new BuddyAgentRunError('RUN_NOT_FOUND')
    if (run.status !== 'queued')
      throw new BuddyAgentRunError('RUN_STATE_MISMATCH')

    const conversation = this.#options.conversations.findById(run.conversationId)
    if (
      !conversation
      || conversation.deletedAt !== null
      || conversation.activeBranchId !== run.branchId
    ) {
      throw new BuddyAgentRunError('CONVERSATION_BINDING_MISMATCH')
    }
    let actor = await recoverRunActorSnapshot(run, this.#options)
    if (actor && this.#options.getFileAccessCeiling?.(run.id) === 'read_only')
      actor = { ...actor, settings: { ...actor.settings, limits: { fileAccess: 'read_only' } } }
    const session = await this.#options.sessions.createForConversation({
      threadId: run.threadId,
      contextMode: run.purpose === 'conversation.compaction' ? 'compaction' : 'execution',
      actor,
      approvalPolicy: run.approvalPolicy,
      branchId: run.branchId,
      conversationId: run.conversationId,
      executionProfile: run.executionProfile,
      executionContext: run.executionContext,
      spaceId: conversation.spaceId,
      sessionMode: run.purpose === 'automation'
        ? 'automation_background'
        : 'interactive',
    })
    const common = {
      runId: run.id,
      session,
    }

    if (run.purpose === 'conversation.compaction') {
      const command = this.#options.commands.findByRunId(run.id)
      if (
        !command
        || command.command !== 'compact'
        || command.conversationId !== run.conversationId
        || command.branchId !== run.branchId
        || !run.piSessionFile
      ) {
        throw new BuddyAgentRunError('CONVERSATION_BINDING_MISMATCH')
      }
      return {
        input: {
          ...common,
          customInstructions: command.arguments,
        },
        kind: 'compaction',
      }
    }

    const input = this.#options.runInputs.findByRunId(run.id)
    if (!input?.prompt.trim())
      throw new BuddyAgentRunError('RUN_INPUT_NOT_FOUND')
    const selections = input.contextItems.flatMap(item => item.kind === 'skill' ? [item.skill ?? item.value] : [])
    for (const selection of selections) {
      if (typeof selection !== 'string' && !(session.resources.availableSkillReferences ?? session.resources.skillReferences).some(skill => skill.id === selection.id && skill.name === selection.name))
        throw new SkillError('SKILL_CHANGED')
    }
    const selectedSkills = await this.#options.skills.materializeForSpace(conversation.spaceId, selections)
    for (const { reference: selected } of selectedSkills) {
      if (!(session.resources.availableSkillReferences ?? session.resources.skillReferences).some(skill => skill.id === selected.id && skill.name === selected.name && skill.revision === selected.revision))
        throw new SkillError('SKILL_CHANGED')
    }
    const { images, documents, resourceLabels } = await this.#options.attachments.resolveInputReferences(
      input.attachmentIds,
      run.conversationId,
      input.prompt,
    )
    const effectiveModel = this.#options.runs.findById(run.id)?.modelOverride ?? actor?.model
    const changedModel = effectiveModel && (effectiveModel.providerId !== run.provider || effectiveModel.modelId !== run.model)
    await this.#options.models.resolveAvailable({
      contextWindow: changedModel ? null : run.contextWindow,
      maxTokens: changedModel ? null : run.maxTokens,
      modelId: effectiveModel?.modelId ?? run.model,
      providerId: effectiveModel?.providerId ?? run.provider,
    })
    return {
      input: {
        ...common,
        serviceTier: input.serviceTier,
        thinkingLevel: input.reasoning ?? undefined,
        userInput: createBuddyInputReference({
          attachmentIds: [...input.attachmentIds],
          resourceLabels,
          ...(documents.length ? { documents } : {}),
          images,
          messageId: run.triggeringMessageId,
          prompt: input.prompt,
        }),
      },
      kind: 'turn',
    }
  }
}
