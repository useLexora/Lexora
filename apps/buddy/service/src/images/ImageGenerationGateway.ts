import type { Api, ImageContent, Model } from '@earendil-works/pi-ai'
import type { ImageOutputOptions, ImagePreferencesSnapshot, ImageSource, ImageTarget } from '../../../shared/images/imagePreferences'

export const IMAGE_GENERATION_ERROR_CODES = [
  'IMAGE_GENERATION_FAILED',
  'IMAGE_GENERATION_BUSY',
  'IMAGE_GENERATION_RESOURCE_EXHAUSTED',
  'IMAGE_GENERATION_INCOMPLETE',
  'IMAGE_GENERATION_INVALID_RESPONSE',
  'IMAGE_GENERATION_RESPONSE_TOO_LARGE',
  'IMAGE_GENERATION_UNSUPPORTED',
  'PROVIDER_ACCESS_DENIED',
  'PROVIDER_AUTHENTICATION_FAILED',
  'PROVIDER_RATE_LIMITED',
] as const

export type ImageGenerationErrorCode = typeof IMAGE_GENERATION_ERROR_CODES[number]

export interface ImageGenerationErrorDiagnostic {
  providerCode?: string
  providerParameter?: string
  requestId?: string
}

export interface ImageGenerationInput {
  onAttempt?: (target: ImageTarget, attempt: number, backendRequestId?: string) => Promise<void>
  onSubmitted?: (backendRequestId: string) => Promise<void>

  requestId?: string
  output?: ImageOutputOptions
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
  generate: (input: ImageGenerationInput) => Promise<ImageGenerationResult>
  supports: (model: Model<Api>) => boolean
}

export class ImageGenerationError extends Error {
  readonly retryable: boolean
  readonly outcome: 'failed' | 'unknown'
  readonly code: ImageGenerationErrorCode
  readonly diagnostic: ImageGenerationErrorDiagnostic | null

  constructor(
    code: ImageGenerationErrorCode,
    options?: ErrorOptions & { diagnostic?: ImageGenerationErrorDiagnostic, retryable?: boolean, outcome?: 'failed' | 'unknown' },
  ) {
    super('Lexora Buddy image generation failed', { cause: options?.cause })
    this.name = 'ImageGenerationError'
    this.outcome = code === 'IMAGE_GENERATION_INCOMPLETE' ? 'unknown' : options?.outcome ?? (options?.retryable ? 'failed' : 'unknown')
    this.retryable = this.outcome === 'failed' && (options?.retryable ?? false)
    this.code = code
    this.diagnostic = options?.diagnostic ?? null
  }
}

export function readImageGenerationError(error: unknown): {
  code: ImageGenerationErrorCode
  diagnostic: ImageGenerationErrorDiagnostic | null
} {
  return error instanceof ImageGenerationError
    ? { code: error.code, diagnostic: error.diagnostic }
    : { code: 'IMAGE_GENERATION_FAILED', diagnostic: null }
}
