import type { EventMessage, EventSnapshot } from '../events/eventTypes'
import { z } from 'zod'
import { idSchema, timestampSchema } from '../runtime/apiValidation'

const taskRun = { conversationId: idSchema, branchId: idSchema, runId: idSchema }
export const taskActionEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('task:input:committed'), data: z.object({ ...taskRun, messageId: idSchema, commitId: idSchema }).strict() }).strict(),
  z.object({ type: z.literal('task:turn:completed'), data: z.object({ ...taskRun, triggeringMessageId: idSchema, completedAt: timestampSchema }).strict() }).strict(),
])
type ActionEvent = z.infer<typeof taskActionEventSchema>
export type TaskActionEvents = { [Event in ActionEvent as Event['type']]: EventSnapshot<Event['data']> }
export type TaskActionEvent = EventMessage<TaskActionEvents>
