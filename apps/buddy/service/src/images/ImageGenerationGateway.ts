import type { Api, ImageContent, Model } from '@earendil-works/pi-ai'
import type { ImageGenerationErrorCode, ImageGenerationErrorDiagnostic, ImageGenerationOutcome, ImageRequestRef } from '../../../shared/images/imageGeneration'
import type { ImageOutputOptions, ImagePreferencesSnapshot, ImageSource, ImageSupport, ImageTarget } from '../../../shared/images/imagePreferences'
import { readImageDiagnostic } from '../../../shared/images/imageGeneration'

export { IMAGE_GENERATION_ERROR_CODES } from '../../../shared/images/imageGeneration'
export type { ImageGenerationErrorCode, ImageGenerationErrorDiagnostic } from '../../../shared/images/imageGeneration'

export interface ImageGenerationInput {
  onSubmitting?: () => Promise<void>
  onAttempt?: (target: ImageTarget, attempt: number, backendRequestId?: string) => Promise<void>
  onSubmitted?: (backendRequestId: string) => Promise<void>

  requestId?: string
  output?: Partial<ImageOutputOptions>
  preferences?: ImagePreferencesSnapshot
  inputImages: readonly ImageContent[]
  model: Model<Api>
  prompt: string
  signal: AbortSignal
}

export interface ImageGenerationResult {
  source?: ImageSource
  images: Array<{ bytes: Uint8Array, mimeType: 'image/png' }>
  responseId: string | null
}

export interface ImageGenerationGateway {
  describe?: (input: { model: Model<Api>, preferences?: ImagePreferencesSnapshot, signal?: AbortSignal }) => Promise<ImageGenerationDescription>
  generate: (input: ImageGenerationInput) => Promise<ImageGenerationResult>
  supports: (model: Model<Api>) => boolean
}

export interface ImageGenerationRoute {
  target: ImageTarget
  title: string
  support: ImageSupport
  capabilitySource: 'backend_declaration' | 'adapter_constraints'
}

export interface ImageGenerationDescription {
  generate: ImageGenerationRoute[]
  edit: ImageGenerationRoute[]
}

export class ImageGenerationError extends Error {
  readonly retryable: boolean
  readonly outcome: ImageGenerationOutcome
  readonly code: ImageGenerationErrorCode
  readonly diagnostic: ImageGenerationErrorDiagnostic | null
  readonly request?: ImageRequestRef
  readonly artifactIds: string[]

  constructor(
    code: ImageGenerationErrorCode,
    options?: ErrorOptions & { diagnostic?: ImageGenerationErrorDiagnostic, retryable?: boolean, outcome?: ImageGenerationOutcome, request?: ImageRequestRef, artifactIds?: readonly string[] },
  ) {
    super('Lexora Buddy image generation failed', { cause: options?.cause })
    this.name = 'ImageGenerationError'
    this.outcome = options?.outcome ?? (['IMAGE_GENERATION_INCOMPLETE', 'IMAGE_GENERATION_BLOCKED', 'IMAGE_GENERATION_INVALID_RESPONSE', 'IMAGE_GENERATION_RESPONSE_TOO_LARGE'].includes(code) ? 'unknown' : 'failed')
    this.retryable = this.outcome === 'failed' && (options?.retryable ?? false)
    this.code = code
    this.diagnostic = readImageDiagnostic(options?.diagnostic)
    this.request = options?.request
    this.artifactIds = [...options?.artifactIds ?? []]
  }
}

export function readImageGenerationError(error: unknown): {
  code: ImageGenerationErrorCode
  diagnostic: ImageGenerationErrorDiagnostic | null
  outcome: ImageGenerationOutcome
  request?: ImageRequestRef
  artifactIds?: string[]
} {
  return error instanceof ImageGenerationError
    ? { code: error.code, diagnostic: error.diagnostic, outcome: error.outcome, artifactIds: error.artifactIds, ...(error.request ? { request: error.request } : {}) }
    : { code: 'IMAGE_GENERATION_FAILED', diagnostic: null, outcome: 'unknown' }
}
