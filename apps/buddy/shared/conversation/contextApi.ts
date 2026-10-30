import type { RuntimeRequestContract } from '../runtime/apiContract'
import type { DeepReadonly } from '../runtime/apiValidation'
import { z } from 'zod'
import { approvalPolicySchema, executionProfileSchema, idSchema, sessionIdentitySchema, timestampSchema } from '../runtime/apiValidation'
import { modelSelectionSchema } from './conversationApi'

export const contextUsageSnapshotIdentitySchema = z.object({
  contextWindow: z.number().int().positive(),
  createdAt: timestampSchema,
  modelId: idSchema,
  providerId: idSchema,
})

export const contextUsageSnapshotSchema = z.discriminatedUnion('status', [
  contextUsageSnapshotIdentitySchema.extend({
    status: z.literal('pending'),
  }).strict(),
  contextUsageSnapshotIdentitySchema.extend({
    mcpTokens: z.number().int().nonnegative(),
    messageTokens: z.number().int().nonnegative(),
    skillTokens: z.number().int().nonnegative(),
    status: z.literal('ready'),
    systemPromptTokens: z.number().int().nonnegative(),
    toolTokens: z.number().int().nonnegative(),
    totalTokens: z.number().int().positive(),
  }).strict().refine(snapshot => (
    snapshot.mcpTokens
    + snapshot.messageTokens
    + snapshot.skillTokens
    + snapshot.systemPromptTokens
    + snapshot.toolTokens === snapshot.totalTokens
  ), { path: ['totalTokens'] }),
])

export type LocalContextUsageSnapshot = DeepReadonly<z.infer<typeof contextUsageSnapshotSchema>>

export type LocalContextUsageSnapshotRequest = z.infer<typeof contextRequestSchemas.contextUsageSnapshot>

export const contextRequestSchemas = {
  contextUsageSnapshot: z.object({
    actorId: idSchema.optional(),
    runId: idSchema.optional(),
    approvalPolicy: approvalPolicySchema,
    branchId: sessionIdentitySchema.nullable(),
    conversationId: sessionIdentitySchema.nullable(),
    draftId: sessionIdentitySchema,
    executionProfile: executionProfileSchema,
    modelSelection: modelSelectionSchema,
    spaceId: idSchema.nullable(),
  }).strict().refine(input => (
    (input.conversationId === null) === (input.branchId === null)
  ), { path: ['branchId'] }).refine(input => (
    !input.runId || (input.actorId !== undefined && input.conversationId !== null && input.branchId !== null)
  ), { path: ['runId'] }),
} as const

export const contextResponseSchemas = {
  contextUsageSnapshot: contextUsageSnapshotSchema,
} as const

export const contextRpc = {
  usageSnapshot: { method: 'context.usageSnapshot', input: contextRequestSchemas.contextUsageSnapshot, response: contextResponseSchemas.contextUsageSnapshot },
} as const satisfies Record<string, RuntimeRequestContract>
