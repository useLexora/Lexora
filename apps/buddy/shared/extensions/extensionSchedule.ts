import { z } from 'zod'

export const extensionScheduleIdSchema = z.string().min(1).max(80).regex(/^[a-z][a-z0-9-]*$/)
export const extensionScheduleInputSchema = z.object({
  id: extensionScheduleIdSchema,
  command: z.string().min(1).max(180),
  enabled: z.boolean(),
  intervalMinutes: z.number().int().min(1).max(10080),
}).strict()
export const extensionScheduleSchema = extensionScheduleInputSchema.extend({ nextRunAt: z.number().int().nonnegative().nullable() })
export type ExtensionScheduleInput = z.infer<typeof extensionScheduleInputSchema>
export type ExtensionSchedule = z.infer<typeof extensionScheduleSchema>
export const extensionNotificationSchema = z.object({ title: z.string().trim().min(1).max(100), body: z.string().trim().min(1).max(500) }).strict()
