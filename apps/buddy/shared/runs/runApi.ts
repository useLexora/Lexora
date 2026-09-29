import type { RuntimeNotificationContract, RuntimeRequestContract } from '../runtime/apiContract'
import type { DeepReadonly } from '../runtime/apiValidation'
import { z } from 'zod'
import { artifactSchema } from '../artifacts/artifactApi'
import { approvalPolicySchema, executionProfileSchema, idSchema, nullableTimestampSchema, optionalEventLimitSchema, optionalLimitSchema, timestampSchema } from '../runtime/apiValidation'
import { publicRunEventSchema } from './publicRunEvent'

export const runStatusSchema = z.enum(['queued', 'running', 'completed', 'failed', 'cancelled'])

export const runSchema = z.object({
  approvalPolicy: approvalPolicySchema,
  branchId: idSchema,
  completedAt: nullableTimestampSchema,
  conversationId: idSchema,
  errorCode: z.string().nullable(),
  executionProfile: executionProfileSchema,
  id: idSchema,
  modelId: idSchema,
  providerId: idSchema,
  purpose: z.string().min(1),
  reasoningLevel: z.string().nullable(),
  startedAt: timestampSchema,
  status: runStatusSchema,
  triggeringMessageId: idSchema,
}).strict()

export const runOutputSchema = z.object({
  artifacts: z.array(artifactSchema).min(1).max(512),
  createdAt: timestampSchema,
  runId: idSchema,
  sourceToolCallId: idSchema,
}).strict()

export const runEventEnvelopeSchema = z.object({
  createdAt: timestampSchema,
  payload: z.unknown(),
  runId: idSchema,
  sequence: z.number().int().positive(),
  type: z.string().min(1),
}).strict()

export const runEventSchema = publicRunEventSchema

export type LocalRun = DeepReadonly<z.infer<typeof runSchema>>

export type LocalRunOutput = DeepReadonly<z.infer<typeof runOutputSchema>>

export type LocalRunEvent = DeepReadonly<z.infer<typeof runEventSchema>>

export const runsRequestSchemas = {
  listRuns: z.object({
    conversationId: z.string().nullable().optional(),
    limit: optionalLimitSchema,
  }).strict(),
  runEvents: z.union([
    z.object({
      afterSequence: z.number().int().nonnegative().optional(),
      limit: optionalEventLimitSchema,
      runId: idSchema,
    }).strict(),
    z.object({
      conversationId: idSchema,
      limit: optionalEventLimitSchema,
    }).strict(),
  ]),
  runId: z.object({ runId: idSchema }).strict(),
  runStateEvent: runEventEnvelopeSchema,
} as const

export const runsResponseSchemas = {
  run: runSchema,
  runEvents: z.array(runEventSchema),
  runs: z.array(runSchema),
} as const

export const runsRpc = {
  isBusy: { method: 'runs.isBusy', input: z.object({}).strict(), response: z.boolean() },
  list: { method: 'runs.list', input: z.object({ conversationId: idSchema.nullable().optional(), limit: optionalLimitSchema }).strict(), response: runsResponseSchemas.runs },
  get: { method: 'runs.get', input: runsRequestSchemas.runId, response: runsResponseSchemas.run },
  listEvents: { method: 'runs.listEvents', input: runsRequestSchemas.runEvents, response: z.array(runsRequestSchemas.runStateEvent) },
} as const satisfies Record<string, RuntimeRequestContract>

export const runNotifications = {
  event: { method: 'run.event', params: runEventEnvelopeSchema },
} as const satisfies Record<string, RuntimeNotificationContract>
