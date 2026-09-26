export const BUDDY_THINKING_LEVELS = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const

export type BuddyThinkingLevel = typeof BUDDY_THINKING_LEVELS[number]

export const BUDDY_DEFAULT_THINKING_LEVEL: BuddyThinkingLevel = 'medium'

export const BUDDY_SERVICE_TIERS = ['priority'] as const

export type BuddyServiceTier = typeof BUDDY_SERVICE_TIERS[number]

export const BUDDY_FAST_SERVICE_TIER: BuddyServiceTier = 'priority'

const OPENAI_FAST_MODE_MODEL_IDS = new Set([
  'gpt-5.3-codex',
  'gpt-5.4',
  'gpt-5.4-mini',
  'gpt-5.4-nano',
  'gpt-5.5',
  'gpt-5.6-luna',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-6-astra',
  'gpt-6-luna',
  'gpt-6-sol',
])

export interface BuddyServiceTierOption {
  displayName: string
  id: BuddyServiceTier
}

export function resolveBuddyServiceTiers(input: {
  api: string
  modelId: string
  providerId: string
}): ReadonlyArray<BuddyServiceTierOption> {
  const usesOpenAiResponses = input.providerId === 'openai'
    && input.api === 'openai-responses'
  const usesOpenAiCodexResponses = input.providerId === 'openai-codex'
    && input.api === 'openai-codex-responses'
  if (
    (!usesOpenAiResponses && !usesOpenAiCodexResponses)
    || !OPENAI_FAST_MODE_MODEL_IDS.has(input.modelId)
  ) {
    return []
  }

  return [{ displayName: 'Fast', id: BUDDY_FAST_SERVICE_TIER }]
}

export function isBuddyThinkingLevel(value: string): value is BuddyThinkingLevel {
  return (BUDDY_THINKING_LEVELS as readonly string[]).includes(value)
}

export function isBuddyServiceTier(value: string): value is BuddyServiceTier {
  return (BUDDY_SERVICE_TIERS as readonly string[]).includes(value)
}
