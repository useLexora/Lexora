import type { Api, ImageContent, Model } from '@earendil-works/pi-ai'
import type { ImageOutputOptions, ImagePreferencesSnapshot } from '../../../shared/images/imagePreferences'
import type { CapturedFileWriter } from '../changes/CapturedFileWriter'
import type { DirectoryGrant } from '../directories/resolveGrantedPath'
import type { ImageGenerationGateway } from './ImageGenerationGateway'
import type { ImageRequestReceipt, ImageRequestStore } from './ImageRequestStore'
import { randomUUID } from 'node:crypto'
import { copyEventSnapshot } from '../../../shared/events/eventSnapshot'
import { ArtifactPublicationError } from '../artifacts/ArtifactService'
import { ImageGenerationError } from './ImageGenerationGateway'
import { ImageOperationLifecycle } from './ImageOperationLifecycle'
import { validateGeneratedImages } from './imageResponseBody'

export interface GenerateConversationImageInput {
  output?: Partial<ImageOutputOptions>
  outputPath: string
  prompt: string
  reference?: { mode: 'latest' } | { mode: 'resources', resourceIds: readonly string[] }
}

interface ConversationImageSource {
  materializeConversationImages: (
    conversationId: string,
    ids?: readonly string[],
    access?: { cwd: string, grants: readonly DirectoryGrant[], signal?: AbortSignal },
  ) => Promise<{ images: ImageContent[], records: Array<{ id: string }> }>
}

export interface ImageGenerationServiceOptions {
  requests?: ImageRequestStore
  artifactService: ConversationImageSource & {
    listConversationArtifacts: (conversationId: string) => Array<{ id: string, kind: string, mimeType: string, createdAt: string, updatedAt: string }>
    registerGeneratedImages: (input: {
      conversationId: string
      cwd: string
      grants: readonly DirectoryGrant[]
      images: readonly { bytes: Uint8Array, mimeType: string }[]
      outputPath: string
      sourceArtifactId: string | null
    }, writeFiles?: CapturedFileWriter) => Promise<Array<{ id: string, currentPath: string, mimeType: string }>>
  }
  attachmentService: ConversationImageSource & {
    listForConversation: (conversationId: string) => Array<{ id: string, mimeType: string, createdAt: string }>
  }
  conversationId: string
  cwd: string
  grants: readonly DirectoryGrant[]
  imageGenerationGateway: ImageGenerationGateway
  getImagePreferences?: () => ImagePreferencesSnapshot | undefined
}

export class ImageGenerationService {
  readonly #options: ImageGenerationServiceOptions
  readonly #operations = new ImageOperationLifecycle()
  readonly onDidChange = this.#operations.onDidChange

  constructor(options: ImageGenerationServiceOptions) {
    this.#options = {
      requests: options.requests,
      artifactService: options.artifactService,
      attachmentService: options.attachmentService,
      conversationId: options.conversationId,
      cwd: options.cwd,
      get grants() { return options.grants },
      imageGenerationGateway: options.imageGenerationGateway,
      getImagePreferences: options.getImagePreferences,
    }
  }

  supports(model: Model<Api>): boolean {
    return this.#options.imageGenerationGateway.supports(model)
  }

  describe(model: Model<Api>, signal?: AbortSignal) {
    return this.#options.imageGenerationGateway.describe?.({ model, preferences: this.#options.getImagePreferences?.(), signal })
  }

  generate(input: GenerateConversationImageInput, model: Model<Api>, signal: AbortSignal, grants = this.#options.grants, writeFiles?: CapturedFileWriter, invocation?: { runId: string, toolCallId: string }) {
    const request = copyEventSnapshot(input)
    const directories = copyEventSnapshot(grants)
    const preferences = this.#options.getImagePreferences?.()
    return this.#operations.run({ conversationId: this.#options.conversationId, kind: 'generation', signal }, async (progress) => {
      signal.throwIfAborted()
      if (!this.supports(model))
        throw new ImageGenerationError('IMAGE_GENERATION_UNSUPPORTED', { outcome: 'failed' })
      let references: { artifactIds: string[], images: ImageContent[] } = { artifactIds: [], images: [] }
      try {
        if (request.reference)
          references = await this.#materializeReferences(request.reference, directories, signal)
      }
      catch (cause) {
        signal.throwIfAborted()
        throw new ImageGenerationError('IMAGE_GENERATION_REFERENCE_UNAVAILABLE', { cause, outcome: 'failed' })
      }
      signal.throwIfAborted()
      if (request.reference && !references.images.length)
        throw new ImageGenerationError('IMAGE_GENERATION_REFERENCE_UNAVAILABLE', { outcome: 'failed' })
      const receipt = invocation && this.#options.requests ? await this.#options.requests.begin(this.#options.conversationId, invocation.runId, invocation.toolCallId) : undefined
      try {
        progress('processing')
        const generated = await this.#options.imageGenerationGateway.generate({
          requestId: receipt?.id ?? randomUUID(),
          onAttempt: receipt?.attempt,
          output: request.output,
          preferences,
          inputImages: references.images,
          model,
          prompt: request.prompt.trim(),
          signal,
        })
        await validateGeneratedImages(generated.images, signal)
        progress('result-received')
        signal.throwIfAborted()
        progress('publishing')
        signal?.throwIfAborted()
        const artifacts = await this.#options.artifactService.registerGeneratedImages({
          conversationId: this.#options.conversationId,
          cwd: this.#options.cwd,
          grants: directories,
          images: generated.images,
          outputPath: request.outputPath.trim(),
          sourceArtifactId: references.artifactIds.at(-1) ?? null,
        }, writeFiles)
        const artifactIds = artifacts.map(artifact => artifact.id)
        const outputs = artifacts.map(artifact => ({ artifactId: artifact.id, path: artifact.currentPath, mimeType: artifact.mimeType }))
        await receipt?.settle('completed', artifactIds, generated.responseId)
        return { value: { artifactIds, outputs, responseId: generated.responseId, ...(generated.source ? { source: generated.source } : {}) }, artifactIds }
      }
      catch (error) {
        await this.#settleFailure(receipt, error)
        throw error
      }
    })
  }

  async #settleFailure(receipt: ImageRequestReceipt | undefined, error: unknown) {
    if (!receipt)
      return
    if (error instanceof ArtifactPublicationError)
      await receipt.settle('partial', [...error.receipt.artifactIds])
    else
      await receipt.settle(error instanceof ImageGenerationError ? error.outcome : 'unknown')
  }

  dispose(): Promise<void> {
    return this.#operations.dispose()
  }

  async #materializeReferences(
    reference: NonNullable<GenerateConversationImageInput['reference']>,
    grants: readonly DirectoryGrant[],
    signal: AbortSignal,
  ): Promise<{ artifactIds: string[], images: ImageContent[] }> {
    const { artifactService, attachmentService, conversationId } = this.#options
    let resourceIds: readonly string[]
    if (reference.mode === 'latest') {
      const candidates = [
        ...artifactService.listConversationArtifacts(conversationId)
          .filter(record => record.kind === 'file' && record.mimeType.startsWith('image/'))
          .map(record => ({ id: record.id, timestamp: Date.parse(record.updatedAt || record.createdAt) || 0 })),
        ...attachmentService.listForConversation(conversationId)
          .filter(record => record.mimeType.startsWith('image/'))
          .map(record => ({ id: record.id, timestamp: Date.parse(record.createdAt) || 0 })),
      ]
      const latest = candidates.reduce<(typeof candidates)[number] | undefined>((selected, candidate) => !selected || candidate.timestamp >= selected.timestamp ? candidate : selected, undefined)
      resourceIds = latest ? [latest.id] : []
    }
    else {
      resourceIds = reference.resourceIds
    }
    const artifactIds: string[] = []
    const images: ImageContent[] = []
    for (const resourceId of resourceIds) {
      try {
        const artifacts = await artifactService.materializeConversationImages(conversationId, [resourceId], { cwd: this.#options.cwd, grants, signal })
        artifactIds.push(resourceId)
        images.push(...artifacts.images)
      }
      catch (error) {
        if ((error as { code?: unknown }).code !== 'ARTIFACT_NOT_FOUND')
          throw error
        const attachments = await attachmentService.materializeConversationImages(conversationId, [resourceId])
        images.push(...attachments.images)
      }
    }
    return { artifactIds, images }
  }
}
