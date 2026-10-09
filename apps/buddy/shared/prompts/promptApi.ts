import type { RuntimeRequestContract } from '../runtime/apiContract'
import type { DeepReadonly } from '../runtime/apiValidation'
import { z } from 'zod'
import { BUDDY_EXECUTION_PROFILES } from '../permissions/executionProfile'
import { validationRequestSchemas } from '../runtime/apiValidation'

export const builtinPromptCatalogSchema = z.object({
  system: z.string().min(1),
  execution: z.record(z.enum(BUDDY_EXECUTION_PROFILES), z.string().min(1)),
  approval: z.string().min(1),
  attachments: z.string().min(1),
  review: z.string().min(1),
}).strict()

export type BuiltinPromptCatalog = DeepReadonly<z.infer<typeof builtinPromptCatalogSchema>>
export type BuiltinPromptId = keyof BuiltinPromptCatalog

export const promptsRpc = {
  get: { method: 'prompts.get', input: validationRequestSchemas.empty, response: builtinPromptCatalogSchema },
} as const satisfies Record<string, RuntimeRequestContract>
