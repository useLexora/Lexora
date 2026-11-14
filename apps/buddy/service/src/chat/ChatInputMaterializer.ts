import type { BuddyPromptDirective, BuddyUserContentV1, BuddyUserMessageResourceSnapshot } from '../../../shared/conversation/buddyUserContent'
import type { BuddyThinkingLevel } from '../../../shared/conversation/modelSelection'
import type { SkillReference } from '../../../shared/skills/skillApi'
import type { AttachmentService } from '../attachments/AttachmentService'
import type { BuddyDefinitionResolver } from '../buddies/BuddyDefinitionResolver'
import type { BuddyTurnContextItem } from '../BuddyRuntime'
import type { InteractiveModelSelection, RuntimeModelProvider } from '../providers/resolveInteractiveModelSelection'
import type { BuddyMaterializedSkill, SkillService } from '../skills/SkillService'
import type { RunInputRecord, RunInputRepository } from '../storage/runInputRepository'
import type { RunRecord } from '../storage/runRecord'
import type { SpaceRecord } from '../storage/spaceRepository'
import type { TurnRequestRecord } from '../storage/turnRequestRepository'
import type { ChatInputHistoryPoint, ChatInputValidationService } from './ChatInputValidationService'
import { Buffer } from 'node:buffer'
import { isAbsolute, join } from 'node:path'
import { readBoundedFile } from '../../../platform/filesystem/boundedFile'
import { isBuddyReviewCommand, isBuddyRunChatCommand, isRetiredBuddyPromptCommand, parseBuddyChatCommand } from '../../../shared/conversation/buddyChatCommands'
import { buddyUserContentToText, getBuddyUserContentActorReferences } from '../../../shared/conversation/buddyUserContent'
import { inputMaterialInlineBytes } from '../../../shared/conversation/inputMaterialProjection'
import { isBuddyThinkingLevel } from '../../../shared/conversation/modelSelection'
import { resolveGrantedPath } from '../directories/resolveGrantedPath'
import { getModelFileInputMimeTypes } from '../providers/modelCapabilities'
import { resolveInteractiveModelSelection } from '../providers/resolveInteractiveModelSelection'
import { BuddyServiceError } from '../rpc/runtimeRequest'
import { SkillError } from '../skills/skillFiles'
import { formatBuddySkillPrompt } from '../skills/SkillService'
import { BUDDY_REVIEW_PROMPT, buildBuddyReviewPrompt } from './buddyReviewPrompt'

const MAX_CONTEXT_FILE_BYTES = 1024 * 1024
const MAX_MODEL_INPUT_BYTES = 4 * 1024 * 1024
const PROMPT_SECTION_SEPARATOR = '\n\n---\n\n'
type ChatContextItem = BuddyTurnContextItem

export interface TurnReplay {
  request: TurnRequestRecord
  run: RunRecord
}

export interface TurnModelSelection extends Omit<InteractiveModelSelection, 'reasoning'> {
  api: string
  contextWindow: number | null
  input: Array<'text' | 'image'>
  fileInputMimeTypes: ReturnType<typeof getModelFileInputMimeTypes>
  maxTokens: number | null
  reasoning: string | null
}

export interface PrepareTurnMaterializationInput {
  actorId: string
  composer?: { content: BuddyUserContentV1, resourceIds: readonly string[], resources?: readonly BuddyUserMessageResourceSnapshot[], sourceMessageId?: string, quoteReadAvailable?: boolean }
  attachmentIds: readonly string[]
  content: string
  contextItems: readonly ChatContextItem[]
  conversationId: string
  branchId: string
  point?: ChatInputHistoryPoint
  draftId: string
  legacyResourceDraftId?: string
  space: SpaceRecord | null
  replay: TurnReplay | null
  requestedModel: InteractiveModelSelection | null
  preparedSelection?: TurnModelSelection
}

interface ChatInputMaterializerOptions {
  attachments: Pick<AttachmentService, 'getInputMetadata' | 'preparePrompt'>
  definitions: Pick<BuddyDefinitionResolver, 'validateActors'>
  inputValidation: Pick<ChatInputValidationService, 'validate'>
  providers: RuntimeModelProvider
  runInputs: Pick<RunInputRepository, 'findByRunId'>
  skills: Pick<SkillService, 'materializeForSpace'>
}

export class ChatInputMaterializer {
  readonly #options: ChatInputMaterializerOptions

  constructor(options: ChatInputMaterializerOptions) {
    this.#options = options
  }

  async prepare(input: PrepareTurnMaterializationInput) {
    const replayInput = input.replay ? requireValue(this.#options.runInputs.findByRunId(input.replay.run.id)) : null
    const selection = input.preparedSelection ?? await this.#resolveSelection(
      input.replay?.run ?? null,
      replayInput,
      input.requestedModel,
    )
    const directives = !replayInput && input.composer
      ? await materializeComposerDirectives(input.composer.content, input.space, this.#options.skills)
      : null
    const composer = directives && input.composer
      ? { ...input.composer, inlineBytes: inputMaterialInlineBytes(selection), resolveDirective: directives.resolveDirective }
      : undefined
    const legacyContext = !replayInput && !composer
      ? await materializeContextItems(input.contextItems, input.space, this.#options.skills)
      : null
    const contextItems = replayInput?.contextItems ?? directives?.contextItems ?? legacyContext?.contextItems ?? input.contextItems
    if (replayInput)
      await this.validateSkills(input.space?.id ?? null, contextItems)
    const attachmentPrompt = replayInput
      ? {
          prompt: '',
          records: this.#options.attachments.getInputMetadata(replayInput.attachmentIds, input.conversationId),
          materialProjection: undefined,
        }
      : await this.#options.attachments.preparePrompt(
          input.attachmentIds,
          input.content,
          input.conversationId,
          input.draftId,
          composer,
          input.legacyResourceDraftId,
        )
    const context = replayInput
      ? ''
      : [
          legacyContext?.prompt ?? '',
          directives?.contextSuffix ?? '',
          input.composer && this.#options.definitions ? formatActorReferences(this.#options.definitions.validateActors(getBuddyUserContentActorReferences(input.composer.content).map(reference => reference.actorId))) : '',
        ].filter(Boolean).join(PROMPT_SECTION_SEPARATOR)
    const prompt = replayInput?.prompt
      ?? [attachmentPrompt.prompt, context].filter(Boolean).join(PROMPT_SECTION_SEPARATOR)
    assertPromptSize(prompt)
    await this.#options.inputValidation.validate({
      actorId: input.replay?.run.buddyId ?? input.actorId,
      conversationId: input.conversationId,
      branchId: input.branchId,
      point: input.point,
      modelId: selection.modelId,
      providerId: selection.providerId,
      contextWindow: selection.contextWindow,
      maxTokens: selection.maxTokens,
      prompt,
      attachments: attachmentPrompt.records,
    })
    const thinkingLevel = normalizeThinkingLevel(
      replayInput ? replayInput.reasoning : selection.reasoning,
    )
    return {
      attachmentPrompt,
      prompt,
      contextItems,
      replayInput,
      reviewRequested: directives?.reviewRequested ?? false,
      selection,
      thinkingLevel,
    }
  }

  async validateSkills(spaceId: string | null, items: readonly RunInputRecord['contextItems'][number][]) {
    const selections = items.filter(item => item.kind === 'skill').map(item => item.skill ?? item.value)
    const loaded = await this.#options.skills.materializeForSpace(spaceId, selections)
    return items.map(item => item.kind === 'skill' ? { ...item, skill: resolveMaterializedSkill(loaded, item.skill ?? item.value).reference } : item)
  }

  async #resolveSelection(
    replayRun: RunRecord | null,
    replayInput: RunInputRecord | null,
    requested: InteractiveModelSelection | null,
  ): Promise<TurnModelSelection> {
    if (replayRun) {
      const model = await this.#options.providers.executionModels.resolveAvailable({
        contextWindow: replayRun.contextWindow,
        maxTokens: replayRun.maxTokens,
        modelId: replayRun.model,
        providerId: replayRun.provider,
      })
      return {
        api: model.api,
        contextWindow: replayRun.contextWindow,
        input: model.input,
        fileInputMimeTypes: getModelFileInputMimeTypes(model),
        maxTokens: replayRun.maxTokens,
        modelId: replayRun.model,
        providerId: replayRun.provider,
        reasoning: replayInput?.reasoning ?? null,
        serviceTier: replayInput?.serviceTier ?? null,
      }
    }
    return resolveInteractiveModelSelection(this.#options.providers, requested)
  }
}

async function materializeComposerDirectives(
  content: BuddyUserContentV1,
  space: SpaceRecord | null,
  skills: Pick<SkillService, 'materializeForSpace'>,
) {
  const directives = content.body.flatMap(paragraph => paragraph.content.filter(node => node.type === 'prompt_directive'))
  if (directives.some(node => node.directive === 'slash_command' && node.commandId))
    throw new BuddyServiceError('VALIDATION_FAILED')
  const textCommand = parseBuddyChatCommand(buddyUserContentToText(content))
  if (textCommand && isBuddyRunChatCommand(textCommand.name))
    throw new BuddyServiceError('VALIDATION_FAILED')
  const hasReviewDirective = directives.some(node => node.directive === 'slash_command' && isBuddyReviewCommand(node.value))
  const reviewsAsText = textCommand?.name === 'review' && !hasReviewDirective
  const selections = directives.flatMap(node => node.directive === 'skill' ? [node.skill ?? node.value] : [])
  const loaded = await skills.materializeForSpace(space?.id ?? null, selections)
  return {
    reviewRequested: hasReviewDirective || reviewsAsText,
    contextSuffix: reviewsAsText ? BUDDY_REVIEW_PROMPT : '',
    contextItems: loaded.map(skill => ({ kind: 'skill' as const, value: skill.name, skill: skill.reference })),
    resolveDirective(directive: BuddyPromptDirective): string {
      if (directive.directive === 'skill') {
        return formatBuddySkillPrompt(resolveMaterializedSkill(loaded, directive.skill ?? directive.value))
      }
      if (isRetiredBuddyPromptCommand(directive.value))
        return directive.value
      if (isBuddyReviewCommand(directive.value) && directive.commandMode === 'prompt')
        return buildBuddyReviewPrompt(parseBuddyChatCommand(directive.value)!.arguments)
      throw new BuddyServiceError('VALIDATION_FAILED')
    },
  }
}

async function materializeContextItems(
  items: readonly ChatContextItem[],
  space: SpaceRecord | null,
  skills: Pick<SkillService, 'materializeForSpace'>,
) {
  const selectedSkills = await skills.materializeForSpace(
    space?.id ?? null,
    items.filter(item => item.kind === 'skill').map(item => item.skill ?? item.value),
  )
  const sections: string[] = []
  for (const item of items) {
    if (item.kind === 'skill') {
      const skill = resolveMaterializedSkill(selectedSkills, item.skill ?? item.value)
      sections.push(formatBuddySkillPrompt(skill))
      continue
    }
    if (item.kind === 'slashCommand')
      continue
    if (!space)
      throw new BuddyServiceError('DIRECTORY_NOT_AUTHORIZED')
    const primaryDirectory = space.primaryDirectory
    const directories = [
      ...(primaryDirectory ? [primaryDirectory] : []),
      ...space.additionalDirectories,
    ]
    const requestedPath = isAbsolute(item.value)
      ? item.value
      : primaryDirectory ? join(primaryDirectory.canonicalRoot, item.value) : null
    if (!requestedPath)
      throw new BuddyServiceError('DIRECTORY_NOT_AUTHORIZED')
    const resolution = await resolveGrantedPath(directories.map(directory => ({
      canonicalRoot: directory.canonicalRoot,
      grantId: directory.id,
      kind: 'workspace' as const,
      root: directory.root,
    })), requestedPath, 'existing')
    const directory = directories.find(item => item.id === resolution.grantId)
    if (!directory)
      throw new BuddyServiceError('DIRECTORY_NOT_AUTHORIZED')
    const content = await readBoundedFile(directory.canonicalRoot, resolution.canonicalPath)
    if (content.byteLength > MAX_CONTEXT_FILE_BYTES)
      throw new BuddyServiceError('VALIDATION_FAILED')
    sections.push(`上下文文件：${item.value}\n\n${content.toString('utf8')}`)
  }
  return {
    prompt: sections.join(PROMPT_SECTION_SEPARATOR),
    contextItems: items.map(item => item.kind === 'skill' ? { ...item, skill: resolveMaterializedSkill(selectedSkills, item.skill ?? item.value).reference } : item),
  }
}

function resolveMaterializedSkill(skills: readonly BuddyMaterializedSkill[], selection: string | SkillReference): BuddyMaterializedSkill {
  const matches = skills.filter(skill => typeof selection === 'string' ? skill.name === selection : skill.reference.id === selection.id)
  if (matches.length > 1)
    throw new SkillError('SKILL_NAME_COLLISION')
  if (!matches[0])
    throw new SkillError('SKILL_NOT_FOUND')
  return matches[0]
}

export function normalizeThinkingLevel(value: string | null | undefined): BuddyThinkingLevel | undefined {
  if (!value)
    return undefined
  if (!isBuddyThinkingLevel(value))
    throw new BuddyServiceError('VALIDATION_FAILED')
  return value
}

export function assertPromptSize(prompt: string): void {
  if (Buffer.byteLength(prompt) > MAX_MODEL_INPUT_BYTES)
    throw new BuddyServiceError('VALIDATION_FAILED')
}

export function toModelParameters(selection: TurnModelSelection) {
  return selection.contextWindow !== null && selection.maxTokens !== null
    ? { contextWindow: selection.contextWindow, maxTokens: selection.maxTokens }
    : undefined
}

function requireValue<T>(value: T | null): T {
  if (value === null)
    throw new BuddyServiceError('VALIDATION_FAILED')
  return value
}

function formatActorReferences(actors: readonly { id: string, name: string }[]): string {
  if (!actors.length)
    return ''
  const routing = actors.length === 1
    ? 'This request is addressed directly to the named actor. This does not change the conversation leader.'
    : 'The conversation leader coordinates these explicitly requested actors. Delegate relevant tasks only to these named actors; bound NPCs may help as private workers.'
  return `${routing}\nRequested conversation actors (stable IDs):\n${JSON.stringify(actors)}`
}
