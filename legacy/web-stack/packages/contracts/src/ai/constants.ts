export const AI_PROVIDER_SCOPE = {
  PLATFORM: 'platform',
  USER: 'user',
} as const

export const AI_PROVIDER_SCOPE_VALUES = [
  AI_PROVIDER_SCOPE.PLATFORM,
  AI_PROVIDER_SCOPE.USER,
] as const

export const AI_PROVIDER_ENDPOINT_MODE = {
  FIXED: 'fixed',
  CUSTOM: 'custom',
} as const

export const AI_PROVIDER_ENDPOINT_MODE_VALUES = [
  AI_PROVIDER_ENDPOINT_MODE.FIXED,
  AI_PROVIDER_ENDPOINT_MODE.CUSTOM,
] as const

export const AI_PROVIDER_AUTH_MODE = {
  API_KEY: 'api-key',
  BEARER: 'bearer',
  NONE: 'none',
} as const

export const AI_PROVIDER_AUTH_MODE_VALUES = [
  AI_PROVIDER_AUTH_MODE.API_KEY,
  AI_PROVIDER_AUTH_MODE.BEARER,
  AI_PROVIDER_AUTH_MODE.NONE,
] as const

export const AI_MODEL_TYPE = {
  CHAT: 'chat',
  EMBEDDING: 'embedding',
  RERANK: 'rerank',
  IMAGE: 'image',
  AUDIO: 'audio',
} as const

export const AI_MODEL_TYPE_VALUES = [
  AI_MODEL_TYPE.CHAT,
  AI_MODEL_TYPE.EMBEDDING,
  AI_MODEL_TYPE.RERANK,
  AI_MODEL_TYPE.IMAGE,
  AI_MODEL_TYPE.AUDIO,
] as const

export const AI_MODEL_MODALITY = {
  TEXT: 'text',
  IMAGE: 'image',
  AUDIO: 'audio',
  VIDEO: 'video',
  FILE: 'file',
  EMBEDDING: 'embedding',
} as const

export const AI_MODEL_MODALITY_VALUES = [
  AI_MODEL_MODALITY.TEXT,
  AI_MODEL_MODALITY.IMAGE,
  AI_MODEL_MODALITY.AUDIO,
  AI_MODEL_MODALITY.VIDEO,
  AI_MODEL_MODALITY.FILE,
  AI_MODEL_MODALITY.EMBEDDING,
] as const

export const AI_MODEL_CAPABILITY = {
  STREAMING: 'streaming',
  TOOL_CALL: 'tool_call',
  REASONING: 'reasoning',
  JSON_MODE: 'json_mode',
  STRUCTURED_OUTPUT: 'structured_output',
} as const

export const AI_MODEL_CAPABILITY_VALUES = [
  AI_MODEL_CAPABILITY.STREAMING,
  AI_MODEL_CAPABILITY.TOOL_CALL,
  AI_MODEL_CAPABILITY.REASONING,
  AI_MODEL_CAPABILITY.JSON_MODE,
  AI_MODEL_CAPABILITY.STRUCTURED_OUTPUT,
] as const

export const AI_MODEL_INTENT_KEY = {
  CHAT_DEFAULT: 'chat.default',
  CHAT_ASSISTANT_DEFAULT: 'chat.assistant.default',
  MEMORY_EMBEDDING_DEFAULT: 'memory.embedding.default',
} as const

export const AI_MODEL_INTENT_KEY_VALUES = [
  AI_MODEL_INTENT_KEY.CHAT_DEFAULT,
  AI_MODEL_INTENT_KEY.CHAT_ASSISTANT_DEFAULT,
  AI_MODEL_INTENT_KEY.MEMORY_EMBEDDING_DEFAULT,
] as const

type AiModelIntentKeyValue = typeof AI_MODEL_INTENT_KEY_VALUES[number]

interface AiModelIntentDefinition {
  parentKey: AiModelIntentKeyValue | null
}

export const AI_MODEL_INTENT_DEFINITIONS = {
  [AI_MODEL_INTENT_KEY.CHAT_DEFAULT]: {
    parentKey: null,
  },
  [AI_MODEL_INTENT_KEY.CHAT_ASSISTANT_DEFAULT]: {
    parentKey: AI_MODEL_INTENT_KEY.CHAT_DEFAULT,
  },
  [AI_MODEL_INTENT_KEY.MEMORY_EMBEDDING_DEFAULT]: {
    parentKey: null,
  },
} as const satisfies Record<AiModelIntentKeyValue, AiModelIntentDefinition>

export const AI_PROVIDER_CREDENTIAL_STATUS = {
  MISSING: 'missing',
  CONFIGURED: 'configured',
} as const

export const AI_PROVIDER_CREDENTIAL_STATUS_VALUES = [
  AI_PROVIDER_CREDENTIAL_STATUS.MISSING,
  AI_PROVIDER_CREDENTIAL_STATUS.CONFIGURED,
] as const

export const AI_PROVIDER_SOURCE = {
  PRESET: 'preset',
  COMPATIBLE: 'compatible',
} as const

export const AI_PROVIDER_SOURCE_VALUES = [
  AI_PROVIDER_SOURCE.PRESET,
  AI_PROVIDER_SOURCE.COMPATIBLE,
] as const

export const AI_DEFAULT_MODEL_STATUS = {
  NOT_CONFIGURED: 'not_configured',
  READY: 'ready',
  INVALID: 'invalid',
} as const

export const AI_DEFAULT_MODEL_STATUS_VALUES = [
  AI_DEFAULT_MODEL_STATUS.NOT_CONFIGURED,
  AI_DEFAULT_MODEL_STATUS.READY,
  AI_DEFAULT_MODEL_STATUS.INVALID,
] as const
