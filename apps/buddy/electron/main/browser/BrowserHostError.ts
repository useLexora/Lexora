import type { BrowserErrorCode, BrowserFailureReason } from '../../../shared/browser'

export class BrowserHostError extends Error {
  readonly code: BrowserErrorCode
  readonly reason: BrowserFailureReason | null

  constructor(
    code: BrowserErrorCode,
    message: string,
    reason: BrowserFailureReason | null = null,
  ) {
    super(message)
    this.code = code
    this.name = 'BrowserHostError'
    this.reason = reason
  }
}
