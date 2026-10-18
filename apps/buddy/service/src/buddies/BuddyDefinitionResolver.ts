import type { BuddySettings } from '../../../shared/buddies/buddySettings'
import type { InteractiveModelSelection, RuntimeModelProvider } from '../providers/resolveInteractiveModelSelection'
import type { ConversationMemberRepository } from '../storage/conversationMemberRepository'
import type { BuddiesService } from './BuddiesService'
import type { BuddyExecutionDefinition } from './BuddyExecutionDefinition'
import { ProviderAuthenticationRequiredError } from '../providers/ProviderFailure'
import { resolveInteractiveModelSelection } from '../providers/resolveInteractiveModelSelection'
import { BuddyServiceError } from '../rpc/runtimeRequest'
import { buddyExecutionDefinitionSchema } from './BuddyExecutionDefinition'

export interface ResolveBuddyDefinitionInput {
  buddyId: string
  kind: 'actor' | 'npc'
  conversationId: string | null
  requestedModel?: InteractiveModelSelection | null
  callerModel?: InteractiveModelSelection
  fileAccessLimit?: BuddySettings['limits']['fileAccess']
}

export class BuddyDefinitionResolver {
  readonly options: {
    buddies: Pick<BuddiesService, 'get'>
    members: Pick<ConversationMemberRepository, 'find'>
    providers: RuntimeModelProvider
  }

  constructor(options: BuddyDefinitionResolver['options']) {
    this.options = options
  }

  validateActors(ids: readonly string[], conversationId?: string) {
    return [...new Set(ids)].map((id) => {
      const buddy = this.options.buddies.get(id)
      if (buddy.deletedAt)
        throw new BuddyServiceError('BUDDY_DELETED')
      if (!buddy.enabled)
        throw new BuddyServiceError('BUDDY_DISABLED')
      if (buddy.kind !== 'actor')
        throw new BuddyServiceError('BUDDY_NOT_ACTOR')
      if (conversationId && this.options.members.find(conversationId, buddy.id) === null)
        throw new BuddyServiceError('BUDDY_NOT_MEMBER')
      return { id: buddy.id, name: buddy.name }
    })
  }

  async resolve(input: ResolveBuddyDefinitionInput) {
    const captured = await this.capture(input)
    const selection = await resolveInteractiveModelSelection(this.options.providers, captured.definition.model)
    this.#validateCaptured(input, captured.definition, captured.memberModelSelection)
    return { ...captured, selection }
  }

  async capture(input: ResolveBuddyDefinitionInput) {
    const buddy = this.options.buddies.get(input.buddyId)
    if (buddy.deletedAt)
      throw new BuddyServiceError('BUDDY_DELETED')
    if (!buddy.enabled)
      throw new BuddyServiceError('BUDDY_DISABLED')
    if (buddy.kind !== input.kind)
      throw new BuddyServiceError('BUDDY_NOT_ACTOR')
    for (const id of buddy.settings.npcTeamEnabled ? buddy.settings.npcIds : []) {
      const target = this.options.buddies.get(id)
      if (target.deletedAt || !target.enabled || target.kind !== 'npc')
        throw new BuddyServiceError('BUDDY_INVALID_NPC_BINDING')
    }
    const member = input.kind === 'actor' && input.conversationId
      ? this.options.members.find(input.conversationId, buddy.id)
      : null
    if (input.kind === 'actor' && input.conversationId && !member)
      throw new BuddyServiceError('BUDDY_NOT_MEMBER')
    const requested = input.requestedModel ?? member?.modelSelection ?? buddy.settings.model
      ?? (input.kind === 'npc' ? input.callerModel ?? null : null)
    const modelSource: BuddyExecutionDefinition['modelSource'] = input.requestedModel
      ? 'input'
      : member?.modelSelection
        ? 'conversation'
        : buddy.settings.model
          ? 'definition'
          : input.kind === 'npc' && input.callerModel ? 'caller' : 'application'
    if (input.kind === 'npc' && !requested)
      throw new BuddyServiceError('VALIDATION_FAILED')
    const selection = requested ?? await this.options.providers.getDefaultModel()
    if (!selection)
      throw new ProviderAuthenticationRequiredError()
    const memberModelSelection = member?.modelSelection ?? null
    const definition = buddyExecutionDefinitionSchema.parse({
      version: 1,
      id: buddy.id,
      kind: buddy.kind,
      revision: buddy.revision,
      settings: {
        ...buddy.settings,
        limits: { fileAccess: input.fileAccessLimit === 'read_only' ? 'read_only' : buddy.settings.limits.fileAccess },
      },
      model: {
        providerId: selection.providerId,
        modelId: selection.modelId,
        reasoning: selection.reasoning ?? null,
        serviceTier: 'serviceTier' in selection ? selection.serviceTier ?? null : null,
      },
      modelSource,
    })
    this.#validateCaptured(input, definition, memberModelSelection)
    return { definition, memberModelSelection }
  }

  #validateCaptured(input: ResolveBuddyDefinitionInput, definition: BuddyExecutionDefinition, memberModelSelection: InteractiveModelSelection | null) {
    const current = this.options.buddies.get(definition.id)
    if (current.revision !== definition.revision)
      throw new BuddyServiceError('BUDDY_CONFLICT')
    for (const id of definition.settings.npcTeamEnabled ? definition.settings.npcIds : []) {
      const npc = this.options.buddies.get(id)
      if (npc.deletedAt || !npc.enabled || npc.kind !== 'npc')
        throw new BuddyServiceError('BUDDY_INVALID_NPC_BINDING')
    }
    if (input.kind === 'actor' && input.conversationId && this.options.members.find(input.conversationId, definition.id) === null)
      throw new BuddyServiceError('BUDDY_NOT_MEMBER')
    if (input.kind === 'actor' && input.conversationId && JSON.stringify(this.options.members.find(input.conversationId, definition.id)?.modelSelection ?? null) !== JSON.stringify(memberModelSelection))
      throw new BuddyServiceError('BUDDY_CONFLICT')
  }
}
