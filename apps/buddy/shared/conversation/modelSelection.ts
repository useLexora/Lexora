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

export interface BuddyServiceTierOption {
  displayName: string
  id: BuddyServiceTier
}

export function isBuddyThinkingLevel(value: string): value is BuddyThinkingLevel {
  return (BUDDY_THINKING_LEVELS as readonly string[]).includes(value)
}

export function isBuddyServiceTier(value: string): value is BuddyServiceTier {
  return (BUDDY_SERVICE_TIERS as readonly string[]).includes(value)
}
