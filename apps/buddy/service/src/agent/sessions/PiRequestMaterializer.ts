import type { Api, Context, Model, UserMessage } from '@earendil-works/pi-ai'
import type { AgentSession } from '@earendil-works/pi-coding-agent'
import type { AttachmentFileInput } from '../../attachments/AttachmentDocumentReference'
import type { AttachmentImageReference } from '../../attachments/AttachmentImageReference'
import type { PreparedAttachmentImage } from '../../attachments/AttachmentImageStore'
import type { InputModel } from '../../providers/modelCapabilities'
import type { BuddyInputReferenceV1 } from '../context/BuddyInputReference'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai'
import { applyDocumentInputPayload } from '../../providers/documentInputPayload'
import { supportsModelFileInput, supportsModelToolCalls } from '../../providers/modelCapabilities'
import { getModelImageLimits, getModelRequestBytesLimit, getModelRequestOverheadReserve } from '../../providers/modelInputBudget'
import { readBuddyInputReference } from '../context/BuddyInputReference'
import { prepareBuddyInputHistory } from '../context/prepareBuddyInputHistory'
import { projectBuddyInput, projectMessageImages } from '../context/projectBuddyInput'

export interface PiInputMaterialization {
  getInputMetadata?: (ids: readonly string[]) => readonly { id: string, sizeBytes: number }[]
  allowsNativeImages?: () => Promise<boolean>
  prepareInputImages?: (images: readonly AttachmentImageReference[], model: InputModel) => Promise<ReadonlyMap<string, PreparedAttachmentImage | null>>
  materializeInput: (input: BuddyInputReferenceV1, images?: ReadonlyMap<string, PreparedAttachmentImage | null>) => Promise<UserMessage['content']>
  materializeDocuments?: (input: BuddyInputReferenceV1) => Promise<AttachmentFileInput[]>
}

interface PiRequestMaterializerOptions extends PiInputMaterialization {
  hasPendingInput: () => boolean
  convertToLlm: AgentSession['agent']['convertToLlm']
  streamFunction: AgentSession['agent']['streamFunction']
  onRequest: (model: Model<Api>) => void
}

export class PiRequestMaterializer {
  readonly #options: PiRequestMaterializerOptions
  readonly #requests = new WeakMap<Context['messages'], { failed: boolean, failureCode?: string, documents: Map<string, AttachmentFileInput> }>()
  #context: Context | null = null

  constructor(options: PiRequestMaterializerOptions) {
    this.#options = options
  }

  get context(): Context | null {
    return this.#context
  }

  reset(): void {
    this.#context = null
  }

  async convert(messages: Parameters<AgentSession['agent']['convertToLlm']>[0], model: Model<Api>) {
    const request = { failed: this.#options.hasPendingInput(), failureCode: undefined as string | undefined, documents: new Map<string, AttachmentFileInput>() }
    const materialized = []
    const projected = new Map<string, BuddyInputReferenceV1>()
    const preparedImages = new Map<string, PreparedAttachmentImage | null>()
    const projectedMessages = new Map<AgentSession['messages'][number], AgentSession['messages'][number]>()
    const imageModel = model.input.includes('image') && await this.#options.allowsNativeImages?.() === false ? { ...model, input: model.input.filter(kind => kind !== 'image') } : model
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
          projectedMessages.set(message, projectMessageImages(message, imageModel, budget))
          continue
        }
        const ids = reference.attachmentIds ?? [...reference.images, ...reference.documents ?? []].map(file => file.attachmentId)
        const sizes = new Map(this.#options.getInputMetadata?.(ids).map(file => [file.id, file.sizeBytes]) ?? [])
        let images: ReadonlyMap<string, PreparedAttachmentImage | null> | undefined
        if (imageModel.input.includes('image') && this.#options.prepareInputImages) {
          images = budget.remainingBytes > 512 && budget.remainingImages > 0
            ? await this.#options.prepareInputImages(reference.images, model)
            : new Map<string, PreparedAttachmentImage | null>()
          for (const image of reference.images) {
            const prepared = images.get(image.attachmentId) ?? null
            sizes.set(image.attachmentId, prepared ? Buffer.byteLength(prepared.image.data, 'base64') : Number.POSITIVE_INFINITY)
          }
        }
        const projection = projectBuddyInput(reference, imageModel, sizes, budget.remainingBytes, budget.remainingImages)
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
        const content = await this.#options.materializeInput(input, preparedImages)
        if (
          !Array.isArray(content)
          || content.some(block => block.type === 'image' && !block.data)
        ) {
          throw new Error('Empty image input')
        }
        const documents = input.documents?.length ? await this.#options.materializeDocuments?.(input) : []
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
      catch (error) {
        request.failed = true
        if (error instanceof Error && error.message === 'MODEL_INPUT_UNSUPPORTED')
          request.failureCode = error.message
      }
    }
    const converted = await this.#options.convertToLlm(materialized)
    this.#requests.set(converted, request)
    return converted
  }

  stream(...[model, context, streamOptions]: Parameters<AgentSession['agent']['streamFunction']>) {
    this.#context = null
    const request = this.#requests.get(context.messages)
    if (request?.failed)
      return createInputMaterializationFailure(model, request.failureCode)
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
    this.#context = requestContext
    this.#options.onRequest(model)
    return this.#options.streamFunction(model, requestContext, {
      ...streamOptions,
      onPayload: async (payload, target) => {
        const previous = await streamOptions?.onPayload?.(payload, target)
        return applyDocumentInputPayload(previous ?? payload, target, request?.documents ?? new Map())
      },
    })
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
