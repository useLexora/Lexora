import type { Api, ImageContent, Model } from '@earendil-works/pi-ai'

export const IMAGE_GENERATION_ERROR_CODES = [
  'IMAGE_GENERATION_FAILED',
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
  inputImages: readonly ImageContent[]
  model: Model<Api>
  prompt: string
  signal: AbortSignal
}

export interface ImageGenerationResult {
  images: Array<{ bytes: Uint8Array, mimeType: 'image/png' }>
  responseId: string | null
}

export interface ImageGenerationGateway {
  generate: (input: ImageGenerationInput) => Promise<ImageGenerationResult>
  supports: (model: Model<Api>) => boolean
}

export class ImageGenerationError extends Error {
  readonly code: ImageGenerationErrorCode
  readonly diagnostic: ImageGenerationErrorDiagnostic | null

  constructor(
    code: ImageGenerationErrorCode,
    options?: ErrorOptions & { diagnostic?: ImageGenerationErrorDiagnostic },
  ) {
    super('Lexora Buddy image generation failed', { cause: options?.cause })
    this.name = 'ImageGenerationError'
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
