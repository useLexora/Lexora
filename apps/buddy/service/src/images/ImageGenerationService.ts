import type { Api, ImageContent, Model } from '@earendil-works/pi-ai'
import type { ImageGenerationRetainedOutput } from '../../../shared/images/imageGeneration'
import type { ImageOutputOptions, ImagePreferencesSnapshot } from '../../../shared/images/imagePreferences'
import type { CapturedFileWriter } from '../changes/CapturedFileWriter'
import type { DirectoryGrant } from '../directories/resolveGrantedPath'
import type { ImageGenerationGateway } from './ImageGenerationGateway'
import type { ImageGenerationMaterialWriter } from './ImageGenerationMaterialStore'
import type { ImageReferenceAccess } from './ImageReferenceAccess'
import type { ImageRequestStore } from './ImageRequestStore'
import { Buffer } from 'node:buffer'
import { createHash, randomUUID } from 'node:crypto'
import { extname, resolve } from 'node:path'
import { diagnosticTransportCode } from '../../../shared/diagnostics/providerRequestDiagnostic'
import { copyEventSnapshot } from '../../../shared/events/eventSnapshot'
import { readImageFileErrorCode } from '../../../shared/images/imageGeneration'
import { imageOutputOptionsSchema } from '../../../shared/images/imagePreferences'
import { ArtifactPublicationError, preflightGeneratedImageOutput } from '../artifacts/ArtifactService'
import { ImageGenerationError, readImageGenerationError } from './ImageGenerationGateway'
import { ImageGenerationMaterialError } from './ImageGenerationMaterialStore'
import { ImageOperationLifecycle } from './ImageOperationLifecycle'
import { validateGeneratedImages } from './imageResponseBody'

export interface GenerateConversationImageInput {
  output?: Partial<ImageOutputOptions>
  outputPath: string
  prompt: string
  referenceIds?: readonly string[]
}

interface ConversationImageSource {
  materializeConversationImages: (
    conversationId: string,
    ids?: readonly string[],
    access?: { cwd: string, grants: readonly DirectoryGrant[], signal?: AbortSignal },
  ) => Promise<{ images: ImageContent[], records: Array<{ id: string }> }>
}

export interface ImageGenerationServiceOptions {
  writeGeneratedImageMaterial?: ImageGenerationMaterialWriter
  requests?: Pick<ImageRequestStore, 'begin' | 'completed'>
  artifactService: ConversationImageSource & {
    registerGeneratedImages: (input: {
      conversationId: string
      cwd: string
      grants: readonly DirectoryGrant[]
      images: readonly { bytes: Uint8Array, mimeType: string }[]
      outputPath: string
      sourceArtifactId: string | null
    }, writeFiles?: CapturedFileWriter) => Promise<Array<{ id: string, currentPath: string, mimeType: string }>>
  }
  attachmentService: ConversationImageSource
  referenceAccess: Pick<ImageReferenceAccess, 'authorize'>
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
      writeGeneratedImageMaterial: options.writeGeneratedImageMaterial,
      artifactService: options.artifactService,
      attachmentService: options.attachmentService,
      referenceAccess: options.referenceAccess,
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
      const completed = invocation && await this.#options.requests?.completed(this.#options.conversationId, invocation.runId, invocation.toolCallId)
      if (completed)
        return { value: { ...completed.result, request: completed.request }, artifactIds: completed.result.artifactIds }
      if (!this.supports(model))
        throw new ImageGenerationError('IMAGE_GENERATION_UNSUPPORTED', { outcome: 'failed' })
      let references: { artifactIds: string[], images: ImageContent[] } = { artifactIds: [], images: [] }
      try {
        if (request.referenceIds) {
          if (!request.referenceIds.length || new Set(request.referenceIds).size !== request.referenceIds.length)
            throw new Error('INVALID_IMAGE_REFERENCES')
          await this.#options.referenceAccess.authorize(request.referenceIds, signal)
          references = await this.#materializeReferences(request.referenceIds, directories, signal)
        }
      }
      catch (cause) {
        signal.throwIfAborted()
        throw new ImageGenerationError('IMAGE_GENERATION_REFERENCE_UNAVAILABLE', { cause, outcome: 'failed' })
      }
      signal.throwIfAborted()
      const output = imageOutputOptionsSchema.parse(request.output ?? {})
      const destination = resolve(this.#options.cwd, request.outputPath.trim())
      const hash = (value: string) => createHash('sha256').update(value).digest('hex')
      const begun = invocation && this.#options.requests
        ? await this.#options.requests.begin(this.#options.conversationId, invocation.runId, invocation.toolCallId, {
            fingerprint: hash(JSON.stringify({ prompt: request.prompt.trim(), output, references: references.images.map(image => ({ mimeType: image.mimeType, digest: hash(image.data) })) })),
            destination: hash(extname(destination) ? destination : `${destination}.png`),
          }, references.images.map((image, index) => ({
            referenceId: request.referenceIds![index]!,
            mimeType: image.mimeType,
            sha256: createHash('sha256').update(Buffer.from(image.data, 'base64')).digest('hex'),
          })))
        : undefined
      if (begun?.kind === 'completed')
        return { value: { ...begun.result, request: begun.request }, artifactIds: begun.result.artifactIds }
      const receipt = begun?.receipt
      let submitted = false
      let responseId: string | null = null
      let artifactIds: string[] = []
      const retainedOutputs: ImageGenerationRetainedOutput[] = []
      let stage: 'preparing' | 'submitting' | 'receiving' | 'publishing' = 'preparing'
      try {
        try {
          await preflightGeneratedImageOutput({ cwd: this.#options.cwd, grants: directories, outputPath: request.outputPath.trim() }, signal)
        }
        catch (cause) {
          signal.throwIfAborted()
          throw new ImageGenerationError('IMAGE_GENERATION_OUTPUT_UNAVAILABLE', { cause, outcome: 'failed', diagnostic: { fileErrorCode: readImageFileErrorCode(cause) ?? 'ARTIFACT_PUBLICATION_FAILED' } })
        }
        signal.throwIfAborted()
        const writeMaterial = this.#options.writeGeneratedImageMaterial
        if (!writeMaterial || !writeFiles)
          throw new ImageGenerationError('IMAGE_GENERATION_FAILED', { outcome: 'failed', diagnostic: { fileErrorCode: 'IMAGE_MATERIAL_UNAVAILABLE' } })
        progress('processing')
        const generated = await this.#options.imageGenerationGateway.generate({
          requestId: receipt?.request.requestId ?? randomUUID(),
          onSubmitting: async () => {
            await receipt?.submitting()
            submitted = true
            stage = 'submitting'
          },
          onAttempt: receipt?.attempt,
          output,
          preferences,
          inputImages: references.images,
          model,
          prompt: request.prompt.trim(),
          signal,
        })
        responseId = generated.responseId
        stage = 'receiving'
        await validateGeneratedImages(generated.images, signal)
        progress('result-received')
        signal.throwIfAborted()
        stage = 'publishing'
        for (const image of generated.images) {
          signal.throwIfAborted()
          try {
            retainedOutputs.push(await writeMaterial(image, directories, writeFiles, signal))
          }
          catch (error) {
            if (error instanceof ImageGenerationMaterialError)
              retainedOutputs.push(error.retainedOutput)
            throw error
          }
          await receipt?.retain(retainedOutputs)
        }
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
        artifactIds = artifacts.map(artifact => artifact.id)
        const outputs = artifacts.map(artifact => ({ artifactId: artifact.id, path: artifact.currentPath, mimeType: artifact.mimeType }))
        const result = { artifactIds, outputs, responseId: generated.responseId, ...(generated.source ? { source: generated.source } : {}) }
        await receipt?.complete(result)
        return { value: { ...result, ...(receipt ? { request: receipt.request } : {}) }, artifactIds }
      }
      catch (error) {
        const publication = error instanceof ArtifactPublicationError ? error.receipt : undefined
        const fileErrorCode = readImageFileErrorCode(error) ?? (stage === 'publishing' ? 'ARTIFACT_PUBLICATION_FAILED' : undefined)
        const failure = error instanceof ImageGenerationError
          ? readImageGenerationError(error)
          : { code: 'IMAGE_GENERATION_FAILED' as const, outcome: stage === 'publishing' ? 'partial' as const : submitted || stage !== 'preparing' ? 'unknown' as const : 'failed' as const, diagnostic: fileErrorCode ? { fileErrorCode } : { transportCode: diagnosticTransportCode(error) } }
        const diagnostic = { stage, ...(fileErrorCode ? { fileErrorCode } : {}), ...(responseId ? { responseId } : {}), ...(receipt ? { localRequestId: receipt.request.requestId } : {}), ...failure.diagnostic }
        const normalized = new ImageGenerationError(failure.code, { cause: error, outcome: stage === 'publishing' ? 'partial' : failure.outcome, diagnostic, request: receipt?.request, artifactIds: publication?.artifactIds ?? artifactIds, ...(retainedOutputs.length ? { retainedOutputs } : {}) })
        await receipt?.fail({ code: normalized.code, outcome: normalized.outcome, diagnostic: normalized.diagnostic, ...(normalized.retainedOutputs ? { retainedOutputs: normalized.retainedOutputs } : {}) }, normalized.artifactIds).catch(() => {})
        if (!retainedOutputs.length)
          signal.throwIfAborted()
        throw normalized
      }
    })
  }

  dispose(): Promise<void> {
    return this.#operations.dispose()
  }

  async #materializeReferences(
    referenceIds: readonly string[],
    grants: readonly DirectoryGrant[],
    signal: AbortSignal,
  ): Promise<{ artifactIds: string[], images: ImageContent[] }> {
    const { artifactService, attachmentService, conversationId } = this.#options
    const artifactIds: string[] = []
    const images: ImageContent[] = []
    for (const referenceId of referenceIds) {
      signal.throwIfAborted()
      let materialized: Awaited<ReturnType<ConversationImageSource['materializeConversationImages']>>
      try {
        materialized = await artifactService.materializeConversationImages(conversationId, [referenceId], { cwd: this.#options.cwd, grants, signal })
        artifactIds.push(referenceId)
      }
      catch (error) {
        if ((error as { code?: unknown }).code !== 'ARTIFACT_NOT_FOUND')
          throw error
        materialized = await attachmentService.materializeConversationImages(conversationId, [referenceId])
      }
      if (materialized.images.length !== 1 || materialized.records.length !== 1 || materialized.records[0]!.id !== referenceId)
        throw new Error('IMAGE_REFERENCE_MISMATCH')
      images.push(materialized.images[0]!)
    }
    return { artifactIds, images }
  }
}
