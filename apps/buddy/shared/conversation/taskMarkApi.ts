import type { RuntimeRequestContract } from '../runtime/apiContract'
import type { DeepReadonly } from '../runtime/apiValidation'
import { z } from 'zod'
import { idSchema, timestampSchema, validationRequestSchemas, validationResponseSchemas } from '../runtime/apiValidation'

export const TASK_MARK_NAME_LIMIT = 20
export const TASK_MARK_DESCRIPTION_LIMIT = 200
export const SYSTEM_UNREAD_MARK_ID = 'system:unread'
export const TASK_MARK_COLORS = ['#3979d6', '#25a18e', '#d49326', '#d85a68', '#9362c6', '#74808b'] as const

export function taskMarkTextLength(value: string): number {
  return Array.from(value).length
}

export const taskMarkInputSchema = z.object({
  name: z.string().trim().min(1).refine(value => taskMarkTextLength(value) <= TASK_MARK_NAME_LIMIT),
  description: z.string().trim().refine(value => taskMarkTextLength(value) <= TASK_MARK_DESCRIPTION_LIMIT),
  color: z.string().regex(/^#[\da-f]{6}$/i).transform(value => value.toLowerCase()),
}).strict()

export const taskMarkSchema = taskMarkInputSchema.extend({
  id: idSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  revision: z.number().int().nonnegative().optional(),
  taskCount: z.number().int().nonnegative(),
}).strict()

export const taskMarkStateSchema = z.object({
  conversationId: idSchema,
  markId: idSchema.nullable(),
  assignmentRevision: z.number().int().nonnegative().optional(),
  resultRunId: idSchema.nullable(),
  readRevision: z.number().int().nonnegative(),
  unread: z.boolean(),
}).strict()

export const taskMarkReadSchema = z.object({
  conversationId: idSchema,
  resultRunId: idSchema.nullable(),
  readRevision: z.number().int().nonnegative(),
  read: z.boolean(),
}).strict()

export const taskMarkClearSchema = taskMarkReadSchema.omit({ read: true }).extend({ expectedAssignmentRevision: z.number().int().nonnegative().optional() })

export type LocalTaskMark = DeepReadonly<z.infer<typeof taskMarkSchema>>
export type LocalTaskMarkState = DeepReadonly<z.infer<typeof taskMarkStateSchema>>
export type TaskMarkInput = z.infer<typeof taskMarkInputSchema>
export type TaskMarkReadInput = z.infer<typeof taskMarkReadSchema>
export type TaskMarkClearInput = z.infer<typeof taskMarkClearSchema>

export const taskMarksRpc = {
  list: { method: 'taskMarks.list', input: validationRequestSchemas.empty, response: z.array(taskMarkSchema) },
  create: { method: 'taskMarks.create', input: taskMarkInputSchema, response: taskMarkSchema },
  update: { method: 'taskMarks.update', input: taskMarkInputSchema.extend({ id: idSchema, expectedRevision: z.number().int().nonnegative().optional() }).strict(), response: taskMarkSchema },
  delete: { method: 'taskMarks.delete', input: z.object({ id: idSchema, expectedRevision: z.number().int().nonnegative().optional() }).strict(), response: validationResponseSchemas.mutation },
  states: { method: 'taskMarks.states', input: z.object({ conversationIds: z.array(idSchema).max(500) }).strict(), response: z.array(taskMarkStateSchema) },
  assign: { method: 'taskMarks.assign', input: z.object({ conversationId: idSchema, markId: idSchema.nullable(), expectedAssignmentRevision: z.number().int().nonnegative().optional() }).strict(), response: taskMarkStateSchema },
  setRead: { method: 'taskMarks.setRead', input: taskMarkReadSchema, response: taskMarkStateSchema },
  clear: { method: 'taskMarks.clear', input: taskMarkClearSchema, response: taskMarkStateSchema },
} as const satisfies Record<string, RuntimeRequestContract>
