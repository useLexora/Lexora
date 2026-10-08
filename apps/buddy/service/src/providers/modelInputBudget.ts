import type { Api, Model } from '@earendil-works/pi-ai'
import { Buffer } from 'node:buffer'

type BudgetModel = Pick<Model<Api>, 'api' | 'inputLimits'>

const MAX_REQUEST_BYTES = 32 * 1024 * 1024
const DEFAULT_IMAGE_RESIZE = { maxWidth: 2000, maxHeight: 2000, maxBytes: 4.5 * 1024 * 1024, jpegQuality: 80 }

export function getModelRequestBytesLimit(model: BudgetModel): number {
  const limit = model.api === 'google-generative-ai' || model.api === 'bedrock-converse-stream'
    ? 20_000_000
    : model.api === 'anthropic-messages' ? 32_000_000 : MAX_REQUEST_BYTES
  return boundedLimit(model.inputLimits?.maxRequestBytes, limit)
}

export function getModelRequestOverheadReserve(model: BudgetModel): number {
  return Math.min(1024 * 1024, Math.floor(getModelRequestBytesLimit(model) / 10))
}

export function getModelImageLimits(model: BudgetModel) {
  return {
    maxPerMessage: boundedLimit(model.inputLimits?.images?.maxPerMessage, 16),
    maxPerRequest: boundedLimit(model.inputLimits?.images?.maxPerRequest, 64),
  }
}

export function getModelImageResize(model: BudgetModel) {
  const configured = model.inputLimits?.images?.resize
  return {
    maxWidth: boundedLimit(configured?.maxWidth, DEFAULT_IMAGE_RESIZE.maxWidth),
    maxHeight: boundedLimit(configured?.maxHeight, DEFAULT_IMAGE_RESIZE.maxHeight),
    maxBytes: boundedLimit(configured?.maxBytes, DEFAULT_IMAGE_RESIZE.maxBytes),
    jpegQuality: boundedLimit(configured?.jpegQuality, DEFAULT_IMAGE_RESIZE.jpegQuality),
  }
}

export function assertModelInputBudget(model: BudgetModel, inputBytes: number): void {
  if (inputBytes + getModelRequestOverheadReserve(model) > getModelRequestBytesLimit(model))
    throw new Error('MODEL_INPUT_TOO_LARGE')
}

export function assertModelRequestBytes(model: BudgetModel, payload: unknown): void {
  const serialized = model.api === 'bedrock-converse-stream' && payload && typeof payload === 'object'
    ? JSON.stringify({ ...payload, modelId: undefined }, (_key, value: unknown) => value instanceof Uint8Array ? Buffer.from(value).toString('base64') : value)
    : JSON.stringify(payload)
  if (Buffer.byteLength(serialized, 'utf8') > getModelRequestBytesLimit(model))
    throw new Error('MODEL_INPUT_TOO_LARGE')
  if (!payload || typeof payload !== 'object')
    return
  const record = payload as Record<string, unknown>
  const messages = record.messages ?? record.contents ?? record.input
  if (!Array.isArray(messages))
    return
  const limits = getModelImageLimits(model)
  const counts = messages.map(countImages)
  if (counts.some(count => count > limits.maxPerMessage) || counts.reduce((total, count) => total + count, 0) > limits.maxPerRequest)
    throw new Error('MODEL_INPUT_TOO_LARGE')
}

export function base64BytesLength(bytes: number): number {
  return Math.ceil(bytes / 3) * 4
}

function boundedLimit(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? Math.min(Math.floor(value), fallback) : fallback
}

function countImages(value: unknown): number {
  if (Array.isArray(value))
    return value.reduce((total, item) => total + countImages(item), 0)
  if (!value || typeof value !== 'object')
    return 0
  const record = value as Record<string, unknown>
  if (['image', 'image_url', 'input_image'].includes(String(record.type)) || record.image)
    return 1
  if (record.inlineData && typeof record.inlineData === 'object' && 'mimeType' in record.inlineData && String(record.inlineData.mimeType).startsWith('image/'))
    return 1
  return countImages(record.content ?? record.parts ?? record.output ?? record.toolResult)
}
