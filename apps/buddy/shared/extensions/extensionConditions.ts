import { z } from 'zod'

export const extensionConditionIdSchema = z.string().max(180).regex(/^[a-z][a-z0-9.-]+$/)
export const extensionConditionInputSchema = z.enum(['configuration', 'runtime.models', 'runtime.task', 'workbench', 'form'])
export type ExtensionConditionInput = z.infer<typeof extensionConditionInputSchema>
export type ConditionParameter = string | number | boolean | null | ConditionParameterArray | ConditionParameterObject
export interface ConditionParameterArray extends Array<ConditionParameter> {}
export interface ConditionParameterObject { [key: string]: ConditionParameter }
const parameterSchema: z.ZodType<ConditionParameter> = z.json()
export const extensionConditionParamsSchema = z.record(z.string().max(80), parameterSchema).refine(value => new TextEncoder().encode(JSON.stringify(value)).byteLength <= 16384, 'Condition parameters are too large')
export const extensionConditionReferenceSchema = z.object({ condition: extensionConditionIdSchema, params: extensionConditionParamsSchema.default({}) }).strict()
export type ExtensionConditionReference = z.infer<typeof extensionConditionReferenceSchema>
export const extensionConditionDefinitionSchema = z.object({
  id: extensionConditionIdSchema,
  inputs: z.array(extensionConditionInputSchema).max(5).refine(inputs => new Set(inputs).size === inputs.length),
}).strict()
export type ExtensionConditionDefinition = z.infer<typeof extensionConditionDefinitionSchema>
export const extensionConditionResultSchema = z.union([
  z.boolean().transform(value => ({ value })),
  z.object({ value: z.boolean(), reason: z.string().max(300).optional() }).strict(),
])
export interface ExtensionConditionResult { value: boolean, reason?: string }
export const extensionConditionStateSchema = z.object({
  status: z.enum(['ready', 'unavailable']),
  value: z.boolean(),
  reason: z.string().max(300).optional(),
}).strict()
export type ExtensionConditionState = z.infer<typeof extensionConditionStateSchema>
export const extensionConditionInvalidationSchema = z.object({
  condition: extensionConditionIdSchema.optional(),
  scopeKey: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict()
export const extensionConditionsChangedSchema = extensionConditionInvalidationSchema.extend({ extensionId: z.string(), revision: z.number().int().positive() }).strict()
export type ExtensionConditionsChanged = z.infer<typeof extensionConditionsChangedSchema>
