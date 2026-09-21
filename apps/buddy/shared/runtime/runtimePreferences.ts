import { z } from 'zod'

export const runtimePreferencesSchema = z.object({
  cacheWarming: z.enum(['off', 'streaming']),
}).strict()

export type RuntimePreferences = z.infer<typeof runtimePreferencesSchema>

export const DEFAULT_RUNTIME_PREFERENCES: RuntimePreferences = {
  cacheWarming: 'off',
}

export const runtimePreferencesRpc = {
  get: 'host.runtimePreferences.get',
  changed: 'runtime.preferences.changed',
} as const
