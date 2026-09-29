import { z } from 'zod'

export const DEFAULT_MODEL_RETRY_LIMIT = 3

export const modelRetryLimitSchema = z.union([z.number().int().nonnegative(), z.literal('unlimited')])
export type ModelRetryLimit = z.infer<typeof modelRetryLimitSchema>

export const runtimePreferencesSchema = z.object({
  cacheWarming: z.enum(['off', 'streaming']),
  modelRetryLimit: modelRetryLimitSchema,
}).strict()

export type RuntimePreferences = z.infer<typeof runtimePreferencesSchema>

export const DEFAULT_RUNTIME_PREFERENCES: RuntimePreferences = {
  cacheWarming: 'off',
  modelRetryLimit: DEFAULT_MODEL_RETRY_LIMIT,
}

export const runtimePreferencesRpc = {
  get: 'host.runtimePreferences.get',
  changed: 'runtime.preferences.changed',
} as const
