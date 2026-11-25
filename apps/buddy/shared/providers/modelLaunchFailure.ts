import { z } from 'zod'
import { launchLocationExtensionId } from '../extensions/extensionLaunchLocation.ts'

export const modelLaunchFailureSchema = z.object({
  version: z.literal(1),
  code: z.enum(['MODEL_LAUNCH_NO_SPACE', 'MODEL_LAUNCH_QUOTA_EXCEEDED']),
  location: z.string().refine(launchLocationExtensionId),
}).strict()
export type ModelLaunchFailureRecord = z.infer<typeof modelLaunchFailureSchema>

export function readModelLaunchFailure(code: unknown, record: unknown): ModelLaunchFailureRecord | undefined {
  if (code !== 'MODEL_LAUNCH_NO_SPACE' && code !== 'MODEL_LAUNCH_QUOTA_EXCEEDED')
    return undefined
  const parsed = modelLaunchFailureSchema.safeParse(record)
  return parsed.success && parsed.data.code === code ? parsed.data : undefined
}
