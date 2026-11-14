export const BUDDY_RUNTIME_PROFILES = ['stable', 'development', 'test'] as const

export type BuddyRuntimeProfile = typeof BUDDY_RUNTIME_PROFILES[number]

export const BUDDY_DEVELOPMENT_RESTART_EXIT_CODE = 75
