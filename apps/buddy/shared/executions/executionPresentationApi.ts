import type { RuntimeRequestContract } from '../runtime/apiContract'
import type { DeepReadonly } from '../runtime/apiValidation'
import { z } from 'zod'
import { artifactSchema } from '../artifacts/artifactApi'
import { changeSetSummarySchema } from '../changes/changeApi'
import { MAX_BUDDY_MESSAGE_TEXT_LENGTH } from '../conversation/buddyMessageContent'
import { buddyComposerDraftDiscardSchema, buddyComposerDraftSchema } from '../conversation/composerDraft'
import { runEventSchema, runSchema, runStatusSchema } from '../runs/runApi'
import { buddyRunProgressSchema } from '../runs/runProgress'
import { idSchema, timestampSchema } from '../runtime/apiValidation'
import { runTokenUsageSchema } from '../usage/runTokenUsage'
import { executionPhaseSchema } from './executionApi'
import { executionWorkSchema } from './executionWork'

export const executionScopeSchema = z.object({ conversationId: idSchema, branchId: idSchema }).strict()
export const executionTargetSchema = executionScopeSchema.extend({ rootRunId: idSchema, runId: idSchema }).strict()
export const executionQuestionPresentationSchema = z.object({
  questionId: z.string().min(1).max(256),
  text: z.string().min(1).max(MAX_BUDDY_MESSAGE_TEXT_LENGTH),
  audience: z.enum(['caller', 'user']),
  open: z.boolean(),
  answered: z.boolean(),
}).strict()
export const executionPresentationSchema = z.object({
  runId: idSchema,
  rootRunId: idSchema,
  parentRunId: idSchema.nullable(),
  buddyId: idSchema,
  buddyName: z.string().min(1).max(80),
  ordinal: z.number().int().positive().nullable(),
  kind: z.enum(['root', 'actor_child', 'npc_child', 'maintenance']),
  phase: executionPhaseSchema,
  status: runStatusSchema,
  startedAt: timestampSchema,
  completedAt: timestampSchema.nullable(),
  updatedAt: timestampSchema,
  progress: buddyRunProgressSchema.nullable(),
  toolCount: z.number().int().nonnegative(),
  usage: runTokenUsageSchema.nullable().default(null),
  stopping: z.boolean(),
  task: z.string().max(300),
  waitingFor: z.enum(['answer', 'approval', 'children', 'resource']).nullable(),
  activeChildren: z.number().int().nonnegative(),
  canCancel: z.boolean(),
  canAnswer: z.boolean(),
  canSend: z.boolean(),
  cleanup: z.enum(['pending', 'clean', 'degraded']),
  errorCode: z.string().nullable(),
  affectedResources: z.array(z.union([z.object({ kind: z.literal('host') }).strict(), z.object({ kind: z.literal('path'), path: z.string().min(1) }).strict()])),
  questions: z.array(executionQuestionPresentationSchema),
}).strict()
export const executionDetailSchema = z.object({
  work: executionWorkSchema.nullable(),
  execution: executionPresentationSchema,
  run: runSchema,
  caller: z.object({ runId: idSchema, buddyName: z.string().min(1).max(80), ordinal: z.number().int().positive().nullable() }).strict().nullable(),
  inputs: z.array(z.object({ kind: z.enum(['supplement', 'answer']), messageId: z.string(), text: z.string(), createdAt: timestampSchema, state: z.enum(['pending', 'accepted', 'consumed', 'undelivered']) }).strict()),
  result: z.string().nullable(),
  artifacts: z.array(artifactSchema),
  changes: changeSetSummarySchema.nullable(),
  usage: runTokenUsageSchema.nullable(),
}).strict()
export const executionSendSchema = executionTargetSchema.extend({
  messageId: z.uuid(),
  text: z.string().trim().min(1).max(MAX_BUDDY_MESSAGE_TEXT_LENGTH),
}).strict()
export const executionSendDraftSchema = executionTargetSchema.extend(buddyComposerDraftDiscardSchema.unwrap().shape).strict()
export const executionEventsRequestSchema = executionTargetSchema.extend({ afterSequence: z.number().int().nonnegative().default(0) }).strict()
export const executionEventsPageSchema = z.object({ events: z.array(runEventSchema), nextSequence: z.number().int().nonnegative(), hasMore: z.boolean() }).strict()
export const executionAnswerSchema = executionTargetSchema.extend({
  messageId: z.uuid().optional(),
  questionId: z.string().min(1).max(256),
  text: z.string().trim().min(1).max(MAX_BUDDY_MESSAGE_TEXT_LENGTH),
}).strict()

export type ExecutionScope = z.infer<typeof executionScopeSchema>
export type ExecutionTarget = z.infer<typeof executionTargetSchema>
export type ExecutionAnswer = z.infer<typeof executionAnswerSchema>
export type ExecutionSend = z.infer<typeof executionSendSchema>
export type ExecutionSendDraft = z.infer<typeof executionSendDraftSchema>
export type ExecutionEventsRequest = z.input<typeof executionEventsRequestSchema>
export type LocalExecutionEventsPage = DeepReadonly<z.infer<typeof executionEventsPageSchema>>
export type LocalExecution = DeepReadonly<z.infer<typeof executionPresentationSchema>>
export type LocalExecutionDetail = DeepReadonly<z.infer<typeof executionDetailSchema>>

export const executionPresentationRpc = {
  list: { method: 'executions.list', input: executionScopeSchema, response: z.array(executionPresentationSchema) },
  detail: { method: 'executions.detail', input: executionTargetSchema, response: executionDetailSchema },
  answer: { method: 'executions.answer', input: executionAnswerSchema, response: z.object({ accepted: z.boolean() }).strict() },
  send: { method: 'executions.send', input: executionSendSchema, response: z.object({ accepted: z.boolean() }).strict() },
  sendDraft: { method: 'executions.sendDraft', input: executionSendDraftSchema, response: buddyComposerDraftSchema.nullable() },
  events: { method: 'executions.events', input: executionEventsRequestSchema, response: executionEventsPageSchema },
  cancel: { method: 'executions.cancel', input: executionTargetSchema, response: z.object({ cancelled: z.boolean() }).strict() },
  cancelChildren: { method: 'executions.cancelChildren', input: executionTargetSchema, response: z.object({ cancelledRunIds: z.array(idSchema) }).strict() },
} as const satisfies Record<string, RuntimeRequestContract>

export const executionsChanged = {
  method: 'executions.changed',
  params: z.object({ sourceId: z.uuid(), revision: z.number().int().positive(), conversationId: idSchema, rootRunId: idSchema }).strict(),
} as const
export type ExecutionsChanged = z.infer<typeof executionsChanged.params>
