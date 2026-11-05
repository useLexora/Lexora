import { z } from 'zod'
import { BUDDY_THINKING_LEVELS } from '../conversation/modelSelection.ts'
import { idSchema } from '../runtime/apiValidation.ts'

export const modelCatalogReferenceSchema = z.object({
  providerId: idSchema,
  modelId: idSchema,
}).strict()

export type ModelCatalogReference = z.infer<typeof modelCatalogReferenceSchema>

export const modelCatalogCandidateSchema = modelCatalogReferenceSchema.extend({
  providerName: z.string().min(1),
  displayName: z.string().min(1),
  contextWindow: z.number().int().positive(),
  maxTokens: z.number().int().positive(),
  input: z.array(z.enum(['text', 'image'])),
  reasoningOptions: z.array(z.enum(BUDDY_THINKING_LEVELS)),
  compatibility: z.string().nullable(),
}).strict()

export const modelCatalogResolutionSchema = z.object({
  source: modelCatalogReferenceSchema.extend({ providerName: z.string().min(1) }).nullable(),
  selection: modelCatalogReferenceSchema.nullable(),
  candidates: z.array(modelCatalogCandidateSchema),
}).strict()
