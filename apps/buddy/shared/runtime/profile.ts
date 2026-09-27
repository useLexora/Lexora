export const BUDDY_RUNTIME_PROFILES = ['stable', 'development', 'test'] as const

export type BuddyRuntimeProfile = typeof BUDDY_RUNTIME_PROFILES[number]
