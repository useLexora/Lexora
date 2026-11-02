import { z } from 'zod'

export const DEFAULT_MODEL_RETRY_LIMIT = 3
export const DEFAULT_CODEMODE_WORKER_LIMIT = 8

export const modelRetryLimitSchema = z.union([z.number().int().nonnegative(), z.literal('unlimited')])
export type ModelRetryLimit = z.infer<typeof modelRetryLimitSchema>
export const codemodeWorkerLimitSchema = z.union([z.number().int().positive(), z.literal('unlimited')])
export type CodemodeWorkerLimit = z.infer<typeof codemodeWorkerLimitSchema>
export const codemodeOverflowSchema = z.enum(['wait', 'reject'])
export const codemodeModeSchema = z.enum(['off', 'on', 'only'])
export type CodemodeMode = z.infer<typeof codemodeModeSchema>

export const runtimePreferencesSchema = z.object({
  cacheWarming: z.enum(['off', 'streaming']),
  codemode: codemodeModeSchema,
  codemodeWorkerLimit: codemodeWorkerLimitSchema,
  codemodeOverflow: codemodeOverflowSchema,
  modelRetryLimit: modelRetryLimitSchema,
}).strict()

export type RuntimePreferences = z.infer<typeof runtimePreferencesSchema>

export const DEFAULT_RUNTIME_PREFERENCES: RuntimePreferences = {
  cacheWarming: 'off',
  codemode: 'on',
  codemodeWorkerLimit: DEFAULT_CODEMODE_WORKER_LIMIT,
  codemodeOverflow: 'wait',
  modelRetryLimit: DEFAULT_MODEL_RETRY_LIMIT,
}

export const runtimePreferencesRpc = {
  get: 'host.runtimePreferences.get',
  changed: 'runtime.preferences.changed',
} as const
