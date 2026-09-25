import { z } from 'zod'

export const extensionInstallationSchema = z.object({
  id: z.string().uuid(),
  name: z.string().max(120),
  extensionId: z.string().max(120).optional(),
  version: z.string().max(80).optional(),
  startedAt: z.string(),
  status: z.enum(['running', 'review', 'completed', 'failed', 'cancelled']),
  stage: z.enum(['download', 'validate', 'review', 'compile', 'install', 'completed']),
  entries: z.array(z.object({ time: z.string(), stage: z.string().max(32), message: z.string().max(600) })).max(100),
  error: z.string().nullable(),
}).strict()
export type ExtensionInstallation = z.infer<typeof extensionInstallationSchema>
export type ExtensionInstallationStage = ExtensionInstallation['stage']
