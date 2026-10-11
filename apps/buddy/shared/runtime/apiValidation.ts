import { z } from 'zod'
import { BUDDY_APPROVAL_POLICIES } from '../permissions/approvalPolicy.ts'
import { BUDDY_EXECUTION_PROFILES } from '../permissions/executionProfile.ts'

export const idSchema = z.string().trim().min(1).max(256)

export const sessionIdentitySchema = z.string().regex(/^[A-Z0-9][\w-]{0,127}$/i)

export const optionalLimitSchema = z.number().int().positive().max(500).optional()

export const optionalEventLimitSchema = z.number().int().positive().max(1_000).optional()

export const optionalCursorSchema = z.string().regex(/^[\w-]+$/).max(2_048).optional()

export const timestampSchema = z.iso.datetime()

export const nullableTimestampSchema = timestampSchema.nullable()

export const executionProfileSchema = z.enum(BUDDY_EXECUTION_PROFILES)

export const approvalPolicySchema = z.enum(BUDDY_APPROVAL_POLICIES)

export const mutationSchema = z.object({ ok: z.literal(true) }).strict()

export type DeepReadonly<T> = T extends ReadonlyArray<infer Item>
  ? ReadonlyArray<DeepReadonly<Item>>
  : T extends object
    ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
    : T

export function isAbsolutePath(value: string): boolean {
  return value.startsWith('/') || /^[A-Z]:[\\/]/i.test(value) || value.startsWith('\\\\')
}

export const validationRequestSchemas = {
  empty: z.object({}).strict(),
  limit: z.object({ limit: optionalLimitSchema }).strict(),
} as const

export const validationResponseSchemas = {
  deleted: z.boolean(),
  mutation: mutationSchema,
} as const
