import type { AiModelIntentKey } from '@haohaoxue/lexora-contracts'
import { AI_MODEL_INTENT_KEY, AI_MODEL_INTENT_KEY_VALUES } from '@haohaoxue/lexora-contracts'

export const PLATFORM_EMBEDDING_MODEL_POLICY_ID = 'platform.embedding.default'

export const USER_CONFIGURABLE_DEFAULT_MODEL_INTENT_KEYS = AI_MODEL_INTENT_KEY_VALUES.filter(
  intentKey => intentKey !== AI_MODEL_INTENT_KEY.MEMORY_EMBEDDING_DEFAULT,
) satisfies AiModelIntentKey[]
