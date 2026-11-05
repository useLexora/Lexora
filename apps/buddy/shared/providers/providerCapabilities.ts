import { z } from 'zod'
import { BUDDY_THINKING_LEVELS } from '../conversation/modelSelection'

export const modelCapabilitiesSchema = z.object({
  image: z.boolean(),
  toolCall: z.boolean().optional(),
  pdf: z.boolean().optional(),
  audio: z.boolean().optional(),
  video: z.boolean().optional(),
  reasoningOptions: z.array(z.enum(BUDDY_THINKING_LEVELS)).min(1).refine(levels => new Set(levels).size === levels.length),
}).strict()

export type ModelCapabilities = z.infer<typeof modelCapabilitiesSchema>

export const modelCapabilityOverridesSchema = modelCapabilitiesSchema.partial()

export type ModelCapabilityOverrides = z.infer<typeof modelCapabilityOverridesSchema>
