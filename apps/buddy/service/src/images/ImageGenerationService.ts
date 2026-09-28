import type { Api, ImageContent, Model } from '@earendil-works/pi-ai'
import type { DirectoryGrant } from '../directories/resolveGrantedPath'
import type { ImageGenerationGateway } from './ImageGenerationGateway'
import { copyEventSnapshot } from '../../../shared/events/eventSnapshot'
import { ImageGenerationError } from './ImageGenerationGateway'
import { ImageOperationLifecycle } from './ImageOperationLifecycle'

export interface GenerateConversationImageInput {
  outputPath: string
  prompt: string
  reference?: { mode: 'latest' } | { mode: 'resources', resourceIds: readonly string[] }
}

interface ConversationImageSource {
  materializeConversationImages: (
    conversationId: string,
    ids?: readonly string[],
  ) => Promise<{ images: ImageContent[], records: Array<{ id: string }> }>
}

export interface ImageGenerationServiceOptions {
  artifactService: ConversationImageSource & {
    registerGeneratedImages: (input: {
      conversationId: string
      cwd: string
      grants: readonly DirectoryGrant[]
      images: readonly { bytes: Uint8Array, mimeType: string }[]
      outputPath: string
      sourceArtifactId: string | null
    }) => Promise<Array<{ id: string }>>
  }
  attachmentService: ConversationImageSource
  conversationId: string
  cwd: string
  grants: readonly DirectoryGrant[]
  imageGenerationGateway: ImageGenerationGateway
}

export class ImageGenerationService {
  readonly #options: ImageGenerationServiceOptions
  readonly #operations = new ImageOperationLifecycle()
  readonly onDidChange = this.#operations.onDidChange

  constructor(options: ImageGenerationServiceOptions) {
    this.#options = {
      artifactService: options.artifactService,
      attachmentService: options.attachmentService,
      conversationId: options.conversationId,
      cwd: options.cwd,
      get grants() { return options.grants },
      imageGenerationGateway: options.imageGenerationGateway,
    }
  }

  supports(model: Model<Api>): boolean {
    return this.#options.imageGenerationGateway.supports(model)
  }

  generate(input: GenerateConversationImageInput, model: Model<Api>, signal: AbortSignal, grants = this.#options.grants) {
    const request = copyEventSnapshot(input)
    const directories = copyEventSnapshot(grants)
    return this.#operations.run({ conversationId: this.#options.conversationId, kind: 'generation', signal }, async (progress) => {
      signal.throwIfAborted()
      if (!this.supports(model))
        throw new ImageGenerationError('IMAGE_GENERATION_UNSUPPORTED')
      const references = request.reference
        ? await this.#materializeReferences(request.reference)
        : { artifactIds: [], images: [] }
      signal.throwIfAborted()
      progress('processing')
      const generated = await this.#options.imageGenerationGateway.generate({
        inputImages: references.images,
        model,
        prompt: request.prompt.trim(),
        signal,
      })
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
      })
      const artifactIds = artifacts.map(artifact => artifact.id)
      return { value: { artifactIds, responseId: generated.responseId }, artifactIds }
    })
  }

  dispose(): Promise<void> {
    return this.#operations.dispose()
  }

  async #materializeReferences(
    reference: NonNullable<GenerateConversationImageInput['reference']>,
  ): Promise<{ artifactIds: string[], images: ImageContent[] }> {
    const { artifactService, attachmentService, conversationId } = this.#options
    if (reference.mode === 'latest') {
      const artifacts = await artifactService.materializeConversationImages(conversationId)
      if (artifacts.images.length > 0) {
        return {
          artifactIds: artifacts.records.map(record => record.id),
          images: artifacts.images,
        }
      }
      const attachments = await attachmentService.materializeConversationImages(conversationId)
      return { artifactIds: [], images: attachments.images }
    }

    const artifactIds: string[] = []
    const images: ImageContent[] = []
    for (const resourceId of reference.resourceIds) {
      try {
        const artifacts = await artifactService.materializeConversationImages(conversationId, [resourceId])
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
