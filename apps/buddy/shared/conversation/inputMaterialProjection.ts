import { readTextMaterialPage } from './textMaterialRead'

export const INPUT_MATERIAL_INLINE_LIMIT = 2048
export const INPUT_MATERIAL_INLINE_BYTES = 8192
export const INPUT_MATERIAL_PREVIEW_LIMIT = 256

export interface InputMaterialProjectionState {
  deferredReferences: boolean
  deferredResourceIds: string[]
}

export class InputMaterialProjectionError extends Error {
  readonly code = 'MODEL_INPUT_TOO_LARGE'

  constructor() {
    super('MODEL_INPUT_TOO_LARGE')
  }
}

export function inputMaterialInlineBytes(model?: { contextWindow?: number | null, maxTokens?: number | null }): number {
  if (!model?.contextWindow)
    return INPUT_MATERIAL_INLINE_BYTES
  const inputTokens = model.contextWindow - Math.min(model.maxTokens ?? model.contextWindow / 4, model.contextWindow / 2)
  return Math.min(INPUT_MATERIAL_INLINE_BYTES, Math.max(0, Math.floor(inputTokens / 8)))
}

export class InputMaterialProjectionBudget {
  #remaining: number
  readonly state: InputMaterialProjectionState = { deferredReferences: false, deferredResourceIds: [] }

  constructor(bytes = INPUT_MATERIAL_INLINE_BYTES) {
    this.#remaining = Math.max(0, bytes)
  }

  project(text: string, readAvailable: boolean, metadataBytes = 0): { text: string, deferred: boolean } {
    const bytes = new TextEncoder().encode(JSON.stringify(text)).byteLength - 2 + metadataBytes
    if ((!readAvailable || text.length <= INPUT_MATERIAL_INLINE_LIMIT) && bytes <= this.#remaining) {
      this.#remaining -= bytes
      return { text, deferred: false }
    }
    if (!readAvailable)
      throw new InputMaterialProjectionError()
    this.#remaining = Math.max(0, this.#remaining - metadataBytes)
    const preview = this.#remaining >= 6
      ? readTextMaterialPage(text, { limit: INPUT_MATERIAL_PREVIEW_LIMIT, maxBytes: this.#remaining, maxJsonBytes: this.#remaining + 2 }).text
      : ''
    this.#remaining -= new TextEncoder().encode(JSON.stringify(preview)).byteLength - 2
    return { text: preview, deferred: true }
  }
}
