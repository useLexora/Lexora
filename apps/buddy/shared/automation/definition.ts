import { z } from 'zod'
import { BUDDY_THINKING_LEVELS } from '../conversation/modelSelection'
import { spaceExecutionContextSchema } from '../conversation/space'
import { BUDDY_DEFAULT_EXECUTION_PROFILE, BUDDY_EXECUTION_PROFILES } from '../permissions/executionProfile'
import { AUTOMATION_EXECUTION_SNAPSHOT_MAX_BYTES, AUTOMATION_PROMPT_MAX_BYTES, automationBlockedReasonSchema, automationLifecycleStatusSchema, automationNameSchema, idSchema, utcInstantSchema } from './primitives'
import { automationTimingSchema } from './schedule'

export const automationModelTargetSchema = z.union([
  z.object({ mode: z.literal('default') }).strict(),
  z.object({
    mode: z.literal('pinned'),
    modelId: idSchema,
    providerId: idSchema,
    reasoning: z.enum(BUDDY_THINKING_LEVELS).nullable(),
  }).strict(),
])

export const automationDefinitionShape = {
  actorId: idSchema.nullable().optional(),
  executionProfile: z.enum(BUDDY_EXECUTION_PROFILES).default(BUDDY_DEFAULT_EXECUTION_PROFILE),
  model: automationModelTargetSchema,
  name: automationNameSchema,
  spaceId: idSchema.nullable(),
  prompt: z.string().trim().refine(value => (
    value.length > 0 && new TextEncoder().encode(value).byteLength <= AUTOMATION_PROMPT_MAX_BYTES
  )),
  timing: automationTimingSchema,
} as const

export const automationDefinitionDraftSchema = z.object(automationDefinitionShape).strict()

export const automationExecutionSnapshotSchema = z.object({
  ...automationDefinitionShape,
  spaceContext: spaceExecutionContextSchema.nullable(),
}).strict().superRefine((value, context) => {
  if (
    value.spaceContext !== null
    && value.spaceContext.spaceId !== value.spaceId
  ) {
    context.addIssue({
      code: 'custom',
      path: ['spaceContext'],
    })
  }
  if (
    new TextEncoder().encode(JSON.stringify(value)).byteLength
      > AUTOMATION_EXECUTION_SNAPSHOT_MAX_BYTES
  ) {
    context.addIssue({ code: 'custom' })
  }
})

export const automationSchema = z.object({
  ...automationDefinitionShape,
  blockedReason: automationBlockedReasonSchema.nullable(),
  createdAt: utcInstantSchema,
  id: idSchema,
  lastRunAt: utcInstantSchema.nullable(),
  nextRunAt: utcInstantSchema.nullable(),
  revision: z.number().int().positive(),
  status: automationLifecycleStatusSchema,
  updatedAt: utcInstantSchema,
}).strict().superRefine((automation, context) => {
  if ((automation.status === 'blocked') !== (automation.blockedReason !== null)) {
    context.addIssue({
      code: 'custom',
      path: ['blockedReason'],
    })
  }
  if ((automation.status === 'active') !== (automation.nextRunAt !== null)) {
    context.addIssue({
      code: 'custom',
      path: ['nextRunAt'],
    })
  }
})

export type AutomationModelTarget = z.infer<typeof automationModelTargetSchema>

export type AutomationDefinitionDraft = z.infer<typeof automationDefinitionDraftSchema>

export type AutomationExecutionSnapshot = z.infer<typeof automationExecutionSnapshotSchema>

export type Automation = z.infer<typeof automationSchema>
