import { z } from 'zod'

export const speechKindSchema = z.enum(['speech.transcribe', 'speech.synthesize'])
export type SpeechKind = z.infer<typeof speechKindSchema>
export const speechProviderSchema = z.object({ id: z.string().min(1).max(256), title: z.string().max(256).optional() }).strict()
export type SpeechProviderRef = z.infer<typeof speechProviderSchema>
const savedProvider = z.union([
  speechProviderSchema,
  z.object({ extensionId: z.string().min(1).max(160), capability: z.string().min(1).max(80) }).strict().transform((value): SpeechProviderRef => ({ id: `extension:${value.extensionId}:${value.capability}` })),
])
const savedModel = z.union([
  savedProvider,
  z.object({ model: savedProvider.nullable().optional(), service: z.unknown().optional() }).strict().transform(value => value.model),
]).nullable().optional().transform((value) => {
  if (value?.id.startsWith('direct:'))
    return null
  return value
}).optional()
const savedPreferences = z.object({
  inputEnabled: z.boolean().optional(),
  outputEnabled: z.boolean().optional(),
  transcribe: savedModel,
  synthesize: savedModel,
  input: z.enum(['model', 'service']).optional(),
  output: z.enum(['system', 'model', 'service', 'provider']).optional(),
  voiceSettings: z.record(z.string().max(256), z.object({ voice: z.string().max(256), rate: z.number().min(0.5).max(2) }).strict()).optional(),
  transcriptionSettings: z.record(z.string().max(256), z.object({ language: z.string().max(12) }).strict()).optional(),
  systemVoice: z.string().max(512).optional(),
  systemRate: z.number().min(0.5).max(2).optional(),
}).strict()
export const speechPreferencesSchema = savedPreferences.transform(({ input: _input, output, ...preferences }) => ({
  ...preferences,
  ...(output ? { output: output === 'system' || ((output === 'service' || output === 'provider') && !preferences.synthesize) ? 'system' as const : 'model' as const } : {}),
}))
export type SpeechPreferences = z.infer<typeof speechPreferencesSchema>
export const speechProviderDescriptorSchema = speechProviderSchema.extend({
  title: z.string().min(1).max(256),
  source: z.string().max(256).optional(),
  providerId: z.string().max(160).optional(),
  modelId: z.string().max(200).optional(),
  rateRange: z.object({ min: z.number(), max: z.number() }).strict().optional(),
  supportsRate: z.boolean().optional(),
  supportsVoiceSelection: z.boolean().optional(),
  supportsLanguageSelection: z.boolean().optional(),
  revision: z.string().max(256),
  kind: speechKindSchema,
  streamingInput: z.boolean(),
  streamingOutput: z.boolean(),
  supported: z.boolean(),
  unavailableReason: z.enum(['provider_disabled', 'model_disabled', 'model_unavailable']).optional(),
  settings: z.object({ extensionId: z.string().max(160), page: z.boolean() }).strict().optional(),
}).strict()
export type SpeechProvider = z.infer<typeof speechProviderDescriptorSchema>
export const speechChoiceSchema = z.object({ id: z.string().min(1).max(256), name: z.string().max(256) }).strict()
export type SpeechChoice = z.infer<typeof speechChoiceSchema>
export const HOST_SPEECH_MODELS = 'host.speech.models'
export interface SpeechCatalog {
  providers: SpeechProvider[]
  preferences: SpeechPreferences
}
export const speechStartSchema = z.object({
  id: z.uuid(),
  provider: speechProviderSchema.extend({ revision: z.string().min(1).max(256) }),
  kind: speechKindSchema,
  text: z.string().trim().min(1).max(16000).optional(),
}).strict().refine(value => (value.kind === 'speech.synthesize') === (value.text !== undefined))
export type SpeechStart = z.infer<typeof speechStartSchema>
export const speechSelectionSchema = z.object({ kind: speechKindSchema, provider: speechProviderSchema.extend({ revision: z.string().min(1).max(256) }) }).strict()
export const speechSessionSchema = z.object({ id: z.uuid() }).strict()
export const speechChunkSchema = speechSessionSchema.extend({ sequence: z.number().int().nonnegative(), bytes: z.instanceof(Uint8Array).refine(value => value.byteLength > 0 && value.byteLength <= 256 * 1024 && value.byteLength % 4 === 0) })
export const speechAckSchema = speechSessionSchema.extend({ sequence: z.number().int().nonnegative() })
export const speechTranscriptSchema = z.object({
  type: z.literal('transcript'),
  segmentId: z.string().min(1).max(80),
  revision: z.number().int().nonnegative(),
  text: z.string().max(16000),
  final: z.boolean(),
}).strict()
export const speechAudioSchema = z.object({
  type: z.literal('audio'),
  sequence: z.number().int().nonnegative(),
  sampleFormat: z.literal('f32le'),
  sampleRate: z.number().int().min(8000).max(96000),
  channels: z.literal(1),
}).strict()
export type SpeechPayload = { type: 'ready' } | z.infer<typeof speechTranscriptSchema> | (z.infer<typeof speechAudioSchema> & { bytes: Uint8Array })
export type SpeechEvent = { id: string } & (
  { type: 'event', sequence: number, payload: SpeechPayload }
  | { type: 'ended', status: 'completed' | 'cancelled' | 'failed', error?: string }
)
export const SPEECH_IPC = {
  voices: 'lexora:speech:voices',
  catalog: 'lexora:speech:catalog',
  changed: 'lexora:speech:changed',
  microphone: 'lexora:speech:microphone',
  select: 'lexora:speech:select',
  start: 'lexora:speech:start',
  write: 'lexora:speech:write',
  finish: 'lexora:speech:finish',
  cancel: 'lexora:speech:cancel',
  event: 'lexora:speech:event',
  ack: 'lexora:speech:ack',
} as const
export function speechEnabled(preferences: SpeechPreferences, kind: SpeechKind): boolean {
  return (kind === 'speech.transcribe' ? preferences.inputEnabled : preferences.outputEnabled) ?? true
}

export type SpeechSource = 'system' | 'model'
export function speechOutput(preferences: SpeechPreferences): SpeechSource {
  return preferences.output ?? (preferences.synthesize ? 'model' : 'system')
}

export function speechSource(preferences: SpeechPreferences, kind: SpeechKind): SpeechSource {
  return kind === 'speech.synthesize' ? speechOutput(preferences) : 'model'
}

export function speechSelection(preferences: SpeechPreferences, kind: SpeechKind): SpeechProviderRef | undefined {
  if (speechSource(preferences, kind) === 'system')
    return undefined
  return (kind === 'speech.synthesize' ? preferences.synthesize : preferences.transcribe) ?? undefined
}

export interface SpeechApi {
  voices: (provider: { id: string, revision: string, kind: SpeechKind }) => Promise<SpeechChoice[]>
  microphone: (active: boolean) => Promise<void>
  catalog: () => Promise<SpeechCatalog>
  select: (input: z.infer<typeof speechSelectionSchema>) => Promise<void>
  start: (input: SpeechStart) => Promise<void>
  write: (input: z.infer<typeof speechChunkSchema>) => Promise<void>
  finish: (id: string) => Promise<void>
  cancel: (id: string) => Promise<void>
  acknowledge: (id: string, sequence: number) => void
  onChanged: (listener: () => void) => () => void
  onEvent: (listener: (event: SpeechEvent) => void) => () => void
}
