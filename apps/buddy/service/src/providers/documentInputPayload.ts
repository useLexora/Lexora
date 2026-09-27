import type { AttachmentFileInput } from '../attachments/AttachmentDocumentReference'
import type { InputModel } from './modelCapabilities'
import { supportsAudioInputMimeType, supportsVideoInputApi, usesAudioDataUrl } from '../../../shared/providers/mediaInput'
import { supportsPdfInputApi } from '../../../shared/providers/pdfInput'
import { assertModelRequestBytes } from './modelInputBudget'

export function applyDocumentInputPayload(
  payload: unknown,
  model: Pick<InputModel, 'api' | 'inputLimits' | 'baseUrl'>,
  files: ReadonlyMap<string, AttachmentFileInput>,
): unknown {
  const { api, baseUrl } = model
  if (!files.size) {
    assertModelRequestBytes(model, payload)
    return payload
  }
  if (!supportsPdfInputApi(api) || !isRecord(payload))
    throw new Error('RESOURCE_MATERIALIZATION_FAILED')
  const messageKey = api === 'google-generative-ai' ? 'contents' : ['openai-responses', 'openai-codex-responses'].includes(api) ? 'input' : 'messages'
  const contentKey = api === 'google-generative-ai' ? 'parts' : 'content'
  const messages = payload[messageKey]
  if (!Array.isArray(messages))
    throw new Error('RESOURCE_MATERIALIZATION_FAILED')
  const inserted = new Set<string>()
  const transformed = messages.map((message: unknown) => {
    if (!isRecord(message) || message.role !== 'user')
      return message
    const content = message[contentKey]
    if (!Array.isArray(content))
      return message
    return {
      ...message,
      [contentKey]: content.map((block: unknown) => {
        if (!isRecord(block) || typeof block.text !== 'string')
          return block
        const file = files.get(block.text)
        if (!file)
          return block
        if (inserted.has(block.text))
          throw new Error('RESOURCE_MATERIALIZATION_FAILED')
        inserted.add(block.text)
        return {
          ...(block.cache_control ? { cache_control: block.cache_control } : {}),
          ...createFileBlock(api, file, baseUrl),
        }
      }),
    }
  })
  if (inserted.size !== files.size)
    throw new Error('RESOURCE_MATERIALIZATION_FAILED')
  const result = { ...payload, [messageKey]: transformed }
  assertModelRequestBytes(model, result)
  return result
}

function createFileBlock(api: string, file: AttachmentFileInput, baseUrl?: string): Record<string, unknown> {
  if (file.mimeType !== 'application/pdf') {
    const audio = file.mimeType.startsWith('audio/')
    const video = file.mimeType === 'video/mp4' || file.mimeType === 'video/webm'
    if ((audio && !supportsAudioInputMimeType(api, file.mimeType, baseUrl)) || (video && !supportsVideoInputApi(api)) || (!audio && !video))
      throw new Error('MODEL_INPUT_UNSUPPORTED')
    if (api === 'google-generative-ai')
      return { inlineData: { mimeType: file.mimeType, data: file.data } }
    if (usesAudioDataUrl(api, baseUrl))
      return { type: 'input_audio', input_audio: { data: `data:${file.mimeType};base64,${file.data}` } }
    return { type: 'input_audio', input_audio: { data: file.data, format: file.mimeType === 'audio/wav' ? 'wav' : 'mp3' } }
  }
  switch (api) {
    case 'anthropic-messages':
      return { type: 'document', title: file.name, source: { type: 'base64', media_type: 'application/pdf', data: file.data } }
    case 'google-generative-ai':
      return { inlineData: { mimeType: 'application/pdf', data: file.data } }
    case 'openai-responses':
      return { type: 'input_file', filename: file.name, file_data: `data:application/pdf;base64,${file.data}` }
    case 'openai-codex-responses':
      return { type: 'input_file', filename: file.name, file_data: `data:application/pdf;base64,${file.data}`, detail: 'high' }
    case 'openai-completions':
      return { type: 'file', file: { filename: file.name, file_data: `data:application/pdf;base64,${file.data}` } }
    default:
      throw new Error('RESOURCE_MATERIALIZATION_FAILED')
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
