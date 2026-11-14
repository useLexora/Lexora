export class AttachmentError extends Error {
  readonly code: string

  constructor(code: string, options?: ErrorOptions) {
    super('Lexora Buddy attachment operation failed', options)
    this.name = 'AttachmentError'
    this.code = code
  }
}
