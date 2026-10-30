import { z } from 'zod'

export const providerModelTypeSchema = z.enum(['chat', 'transcription', 'speech', 'image-generation', 'image-reading'])
export type ProviderModelType = z.infer<typeof providerModelTypeSchema>

export function isChatModel<T extends { type?: ProviderModelType, contextWindow: number | null, maxTokens: number | null }>(model: T): model is T & { contextWindow: number, maxTokens: number } {
  return (model.type ?? 'chat') === 'chat' && model.contextWindow !== null && model.maxTokens !== null
}

export function speechKindForModel(type: ProviderModelType) {
  return type === 'transcription' ? 'speech.transcribe' as const : type === 'speech' ? 'speech.synthesize' as const : null
}
