import type { Api, Context, Model, UserMessage } from '@earendil-works/pi-ai'
import type {
  AgentSession,
  SessionEntry,
} from '@earendil-works/pi-coding-agent'
import type { RuntimePreferences } from '../../../../shared/runtime/runtimePreferences'
import type { SkillReference } from '../../../../shared/skills/skillApi'
import type { AttachmentFileInput } from '../../attachments/AttachmentDocumentReference'
import type { AttachmentImageReference } from '../../attachments/AttachmentImageReference'
import type { PreparedAttachmentImage } from '../../attachments/AttachmentImageStore'
import type { InputModel } from '../../providers/modelCapabilities'
import type {
  BuddyInputReferenceStore,
  BuddyInputReferenceV1,
} from '../context/BuddyInputReference'
import type { BuddyExtensionRunContextStore } from '../extensions/BuddyExtensionRunContext'
import type { BuddySessionShutdownReason, BuddySessionTurnContext, ReusableBuddySession } from './ReusableBuddySession'
import type { BuddyConversationTreeCursor } from './tree/BuddyConversationTree'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai'
import { prepareCompaction } from '@earendil-works/pi-coding-agent'
import { BUDDY_DEFAULT_THINKING_LEVEL } from '../../../../shared/conversation/modelSelection'
import { DEFAULT_RUNTIME_PREFERENCES } from '../../../../shared/runtime/runtimePreferences'
import { applyDocumentInputPayload } from '../../providers/documentInputPayload'
import { supportsModelFileInput, supportsModelToolCalls } from '../../providers/modelCapabilities'
import { getModelImageLimits, getModelRequestBytesLimit, getModelRequestOverheadReserve } from '../../providers/modelInputBudget'
import { SkillError } from '../../skills/skillFiles'
import { createBuddyInputReferenceMessage, readBuddyInputReference } from '../context/BuddyInputReference'
import { createContextUsageBreakdown } from '../context/contextUsageBreakdown'
import { prepareBuddyInputHistory } from '../context/prepareBuddyInputHistory'
import { projectBuddyInput, projectMessageImages } from '../context/projectBuddyInput'
import { toBuddySessionStorageError } from './BuddySessionErrors'
import { getBuddyCacheWarmingStatus } from './getBuddyCacheWarmingStatus'

export interface CreateReusableBuddySessionOptions {
  setCodemodeEnabled?: (enabled: boolean) => void
  skillReferences?: readonly SkillReference[]
  tree?: BuddyConversationTreeCursor
  assertModelAccess: (
    provider: string,
    model: string,
    contextWindow: number | null,
    maxTokens: number | null,
  ) => Promise<Model<Api>>
  inputReferences: BuddyInputReferenceStore
  getInputMetadata?: (ids: readonly string[]) => readonly { id: string, sizeBytes: number }[]
  prepareInputImages?: (images: readonly AttachmentImageReference[], model: InputModel) => Promise<ReadonlyMap<string, PreparedAttachmentImage | null>>
  materializeInput: (input: BuddyInputReferenceV1, images?: ReadonlyMap<string, PreparedAttachmentImage | null>) => Promise<UserMessage['content']>
  materializeDocuments?: (input: BuddyInputReferenceV1) => Promise<AttachmentFileInput[]>
  runContext: BuddyExtensionRunContextStore
  session: AgentSession
  shutdown: (reason: BuddySessionShutdownReason) => Promise<void>
}

export function createReusableBuddySession(
  options: CreateReusableBuddySessionOptions,
): ReusableBuddySession & { applyPreferences: (preferences: RuntimePreferences) => void } {
  const { session } = options
  let preferences = DEFAULT_RUNTIME_PREFERENCES
  let turnRetryLimit: RuntimePreferences['modelRetryLimit'] | undefined
  function applySessionSettings(mode: RuntimePreferences['cacheWarming']) {
    if (session.settingsManager.getCacheWarmingMode() !== mode)
      session.setCacheWarmingMode(mode)
    if (turnRetryLimit !== undefined) {
      session.settingsManager.applyOverrides({
        retry: {
          enabled: turnRetryLimit !== 0,
          maxRetries: turnRetryLimit === 'unlimited' ? Number.POSITIVE_INFINITY : turnRetryLimit,
        },
      })
    }
  }
  const convertToLlm = session.agent.convertToLlm
  const streamFunction = session.agent.streamFunction
  let latestContext: Context | null = null
  const pendingInputs = new Map<string, BuddyInputReferenceV1>()
  const requestInputs = new WeakMap<Context['messages'], { failed: boolean, documents: Map<string, AttachmentFileInput> }>()
  function enqueueInput(mode: 'steer' | 'followUp', prepare: () => BuddyInputReferenceV1, skills: readonly SkillReference[] = []) {
    if (!session.isStreaming || options.runContext.current?.signal.aborted)
      return false
    for (const skill of skills) {
      if (!options.skillReferences?.some(active => active.id === skill.id && active.name === skill.name && active.revision === skill.revision)) {
        if (mode === 'followUp')
          return false
        throw new SkillError('SKILL_CHANGED')
      }
    }
    const input = prepare()
    pendingInputs.set(input.messageId, input)
    session.agent[mode](createBuddyInputReferenceMessage(input, Date.now()))
    return true
  }
  session.agent.convertToLlm = async (messages) => {
    const request = { failed: options.inputReferences.pending !== null, documents: new Map<string, AttachmentFileInput>() }
    const materialized = []
    const projected = new Map<string, BuddyInputReferenceV1>()
    const preparedImages = new Map<string, PreparedAttachmentImage | null>()
    const projectedMessages = new Map<AgentSession['messages'][number], AgentSession['messages'][number]>()
    const model = session.model
    if (!model)
      throw new Error('Missing input model')
    const history = prepareBuddyInputHistory(messages)
    const imageLimits = getModelImageLimits(model)
    const mergeToolImages = ['openai-completions', 'anthropic-messages', 'bedrock-converse-stream'].includes(model.api)
    const budget = {
      remainingBytes: getModelRequestBytesLimit(model) - getModelRequestOverheadReserve(model)
        - Buffer.byteLength(JSON.stringify(history.map(message => projectMessageImages(message, { ...model, input: ['text'] }))), 'utf8'),
      remainingImages: imageLimits.maxPerRequest,
      remainingMessageImages: imageLimits.maxPerMessage,
    }
    try {
      let previousRole: AgentSession['messages'][number]['role'] | undefined
      for (const message of [...history].reverse()) {
        if (!mergeToolImages || message.role !== 'toolResult' || previousRole !== 'toolResult')
          budget.remainingMessageImages = imageLimits.maxPerMessage
        previousRole = message.role
        const reference = readBuddyInputReference(message)
        if (!reference) {
          projectedMessages.set(message, projectMessageImages(message, model, budget))
          continue
        }
        const ids = reference.attachmentIds ?? [...reference.images, ...reference.documents ?? []].map(file => file.attachmentId)
        const sizes = new Map(options.getInputMetadata?.(ids).map(file => [file.id, file.sizeBytes]) ?? [])
        let images: ReadonlyMap<string, PreparedAttachmentImage | null> | undefined
        if (model.input.includes('image') && options.prepareInputImages) {
          images = budget.remainingBytes > 512 && budget.remainingImages > 0
            ? await options.prepareInputImages(reference.images, model)
            : new Map<string, PreparedAttachmentImage | null>()
          for (const image of reference.images) {
            const prepared = images.get(image.attachmentId) ?? null
            sizes.set(image.attachmentId, prepared ? Buffer.byteLength(prepared.image.data, 'base64') : Number.POSITIVE_INFINITY)
          }
        }
        const projection = projectBuddyInput(reference, model, sizes, budget.remainingBytes, budget.remainingImages)
        for (const image of projection.input.images) {
          const prepared = images?.get(image.attachmentId)
          if (prepared)
            preparedImages.set(image.attachmentId, prepared)
        }
        projected.set(reference.messageId, projection.input)
        budget.remainingBytes -= projection.bytes
        budget.remainingImages -= projection.input.images.length
      }
    }
    catch {
      request.failed = true
    }
    for (const message of history) {
      try {
        const reference = readBuddyInputReference(message)
        if (!reference) {
          materialized.push(projectedMessages.get(message) ?? message)
          continue
        }
        const input = projected.get(reference.messageId)
        if (!input)
          throw new Error('Missing input projection')
        const content = await options.materializeInput(input, preparedImages)
        if (
          !Array.isArray(content)
          || content.some(block => block.type === 'image' && !block.data)
        ) {
          throw new Error('Empty image input')
        }
        const documents = input.documents?.length ? await options.materializeDocuments?.(input) : []
        if (!documents || documents.length !== (input.documents?.length ?? 0))
          throw new Error('Missing document input')
        const documentBlocks = documents.flatMap((file, index) => {
          const token = `buddy-file:${randomUUID()}`
          request.documents.set(token, file)
          return [
            { type: 'text' as const, text: `Native attachment: ${input.documents![index]!.attachmentId} (${JSON.stringify(file.name)})` },
            { type: 'text' as const, text: token },
          ]
        })
        materialized.push({ content: [...content, ...documentBlocks], role: 'user' as const, timestamp: message.timestamp })
      }
      catch {
        request.failed = true
      }
    }
    const converted = await convertToLlm(materialized)
    requestInputs.set(converted, request)
    return converted
  }
  session.agent.streamFunction = (model, context, streamOptions) => {
    const request = requestInputs.get(context.messages)
    if (request?.failed)
      return createInputMaterializationFailure(model)
    if (request && [...request.documents.values()].some(file => !supportsModelFileInput(model, file.mimeType)))
      return createInputMaterializationFailure(model, 'MODEL_INPUT_UNSUPPORTED')
    const requestContext = supportsModelToolCalls(model)
      ? context
      : {
          ...context,
          messages: context.messages.map(message => message.role === 'system'
            ? { ...message, toolsAdded: undefined, toolsRemoved: undefined }
            : message),
        }
    latestContext = requestContext
    return streamFunction(model, requestContext, {
      ...streamOptions,
      onPayload: async (payload, target) => {
        const previous = await streamOptions?.onPayload?.(payload, target)
        return applyDocumentInputPayload(previous ?? payload, target, request?.documents ?? new Map())
      },
    })
  }
  return {
    getCacheWarmingStatus: () => getBuddyCacheWarmingStatus({
      mode: preferences.cacheWarming,
      model: session.model,
      active: !!options.runContext.current && !options.runContext.current.signal.aborted,
      status: session.cacheWarmingStatus,
    }),
    applyPreferences: (next) => {
      preferences = next
      applySessionSettings(options.runContext.current && !options.runContext.current.signal.aborted ? preferences.cacheWarming : 'off')
    },
    getModelUsage: () => session.model ? { providerId: session.model.provider, modelId: session.model.id } : null,
    getInputContext: () => {
      const messages = [...session.messages]
      for (const message of messages) {
        const input = readBuddyInputReference(message)
        if (input)
          pendingInputs.delete(input.messageId)
      }
      messages.push(...[...pendingInputs.values()].map(input => createBuddyInputReferenceMessage(input, Date.now())))
      return { messages }
    },
    steer: (prepare, skills) => enqueueInput('steer', prepare, skills),
    followUp: (prepare, skills) => enqueueInput('followUp', prepare, skills),
    abort: () => {
      applySessionSettings('off')
      pendingInputs.clear()
      session.agent.clearSteeringQueue()
      session.agent.clearFollowUpQueue()
      return session.abort()
    },
    abortCompaction: () => session.abortCompaction(),
    canCompact: () => canPreparePiCompaction(
      session.sessionManager.getBranch(),
      session.settingsManager.getCompactionSettings(session.model),
    ),
    async activateTurn(input) {
      input.signal.throwIfAborted()
      turnRetryLimit = preferences.modelRetryLimit
      options.setCodemodeEnabled?.(preferences.codemode)
      options.runContext.current = {
        flushProjectedEvents: input.flushProjectedEvents,
        onToolExecutionAuthorized: input.onToolExecutionAuthorized,
        onToolExecutionDenied: input.onToolExecutionDenied,
        runId: input.runId,
        serviceTier: input.serviceTier ?? null,
        signal: input.signal,
      }
      try {
        await withPiSessionStorageBoundary(
          session,
          async () => {
            await options.tree?.begin(session, input.runId)
            await applyModelSelection(session, options.assertModelAccess, input)
            input.signal.throwIfAborted()
            applySessionSettings(preferences.cacheWarming)
          },
        )
      }
      catch (error) {
        turnRetryLimit = undefined
        options.runContext.current = null
        throw error
      }
      return () => {
        applySessionSettings('off')
        if (options.runContext.current?.runId === input.runId) {
          turnRetryLimit = undefined
          options.runContext.current = null
        }
      }
    },
    shutdown: options.shutdown,
    compact: instructions => withPiSessionStorageBoundary(
      session,
      async () => {
        try {
          return await session.compact(instructions)
        }
        finally {
          await session.waitForIdle()

          options.tree?.finish()
        }
      },
    ),
    getToolLabel: name => session.getToolDefinition(name)?.label,
    getContextUsageBreakdown: totalTokens => latestContext
      ? createContextUsageBreakdown(latestContext, totalTokens)
      : null,
    prompt: (text, promptOptions) => {
      const { inputReference, ...piPromptOptions } = promptOptions ?? {}
      options.inputReferences.pending = inputReference ?? null
      return withPiSessionStorageBoundary(
        session,
        async () => {
          try {
            return await session.prompt(text, piPromptOptions)
          }
          finally {
            await session.waitForIdle()
            pendingInputs.clear()
            session.agent.clearSteeringQueue()
            session.agent.clearFollowUpQueue()
            options.tree?.finish()
          }
        },
      ).finally(() => {
        if (options.inputReferences.pending === inputReference)
          options.inputReferences.pending = null
      })
    },
    subscribe: listener => session.subscribe(listener),
    waitForIdle: () => session.waitForIdle(),
  }
}

function createInputMaterializationFailure(model: Model<Api>, code = 'RESOURCE_MATERIALIZATION_FAILED') {
  const stream = createAssistantMessageEventStream()
  queueMicrotask(() => {
    stream.push({
      error: {
        api: model.api,
        content: [],
        errorMessage: code,
        model: model.id,
        provider: model.provider,
        role: 'assistant',
        stopReason: 'error',
        timestamp: Date.now(),
        usage: {
          cacheRead: 0,
          cacheWrite: 0,
          cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
          input: 0,
          output: 0,
          totalTokens: 0,
        },
      },
      reason: 'error',
      type: 'error',
    })
  })
  return stream
}

async function withPiSessionStorageBoundary<TResult>(
  session: AgentSession,
  operation: () => Promise<TResult>,
): Promise<TResult> {
  try {
    return await operation()
  }
  catch (error) {
    const sessionFile = session.sessionManager.getSessionFile()
    const storageError = sessionFile
      ? toBuddySessionStorageError(error, sessionFile)
      : null
    throw storageError ?? error
  }
}

async function applyModelSelection(
  session: AgentSession,
  assertModelAccess: CreateReusableBuddySessionOptions['assertModelAccess'],
  input: BuddySessionTurnContext,
): Promise<void> {
  const model = await assertModelAccess(
    input.provider,
    input.model,
    input.contextWindow,
    input.maxTokens,
  )
  if (session.model !== model)
    await session.setModel(model)
  session.setThinkingLevel(input.thinkingLevel ?? BUDDY_DEFAULT_THINKING_LEVEL)
}

export function canPreparePiCompaction(
  pathEntries: SessionEntry[],
  settings: Parameters<typeof prepareCompaction>[1],
): boolean {
  return prepareCompaction(pathEntries, settings) !== undefined
}
