import { z } from 'zod'
import { BROWSER_ACTION_TEXT_MAX_LENGTH, BROWSER_MAX_WAIT_TIMEOUT_MS, BROWSER_PRESS_KEYS, BROWSER_WAIT_CONDITIONS, BROWSER_WAIT_MAX_QUIET_MS, BROWSER_WAIT_TEXT_MAX_LENGTH, browserConversationIdSchema, browserElementRefSchema, browserFrameIdSchema, browserIdSchema, browserPathSchema, browserUrlSchema } from './primitives'
import { browserPageOwnerSchema } from './session'

export const browserOpenTargetSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('url'),
    url: browserUrlSchema,
  }).strict(),
  z.object({
    entryPath: browserPathSchema,
    kind: z.literal('local-file'),
    rootPath: browserPathSchema,
  }).strict(),
])

export const browserActionTextSchema = z.string().max(BROWSER_ACTION_TEXT_MAX_LENGTH)

export const browserWaitConditionSchema = z.enum(BROWSER_WAIT_CONDITIONS)

export const browserWaitTimeoutMsSchema = z.number().int().min(1).max(BROWSER_MAX_WAIT_TIMEOUT_MS)

export const browserWaitTextSchema = z.string().trim().min(1).max(BROWSER_WAIT_TEXT_MAX_LENGTH)

export const browserPageReadyWaitSpecSchema = z.object({
  condition: z.literal('page-ready'),
  timeoutMs: browserWaitTimeoutMsSchema,
}).strict()

export const browserUrlChangedWaitSpecSchema = z.object({
  condition: z.literal('url-changed'),
  timeoutMs: browserWaitTimeoutMsSchema,
}).strict()

export const browserUrlMatchesWaitSpecSchema = z.object({
  condition: z.literal('url-matches'),
  pattern: browserWaitTextSchema,
  timeoutMs: browserWaitTimeoutMsSchema,
}).strict()

export const browserTextVisibleWaitSpecSchema = z.object({
  condition: z.literal('text-visible'),
  text: browserWaitTextSchema,
  timeoutMs: browserWaitTimeoutMsSchema,
}).strict()

export const browserDomStableWaitSpecSchema = z.object({
  condition: z.literal('dom-stable'),
  quietMs: z.number().int().min(50).max(BROWSER_WAIT_MAX_QUIET_MS).optional(),
  timeoutMs: browserWaitTimeoutMsSchema,
}).strict()

export const browserWaitSpecSchema = z.discriminatedUnion('condition', [
  browserPageReadyWaitSpecSchema,
  browserUrlChangedWaitSpecSchema,
  browserUrlMatchesWaitSpecSchema,
  browserTextVisibleWaitSpecSchema,
  browserDomStableWaitSpecSchema,
])

export const browserWaitOutcomeSchema = z.object({
  condition: browserWaitConditionSchema,
  elapsedMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  satisfied: z.boolean(),
}).strict()

export const browserOpenParamsSchema = z.object({
  owner: browserPageOwnerSchema,
  conversationId: browserConversationIdSchema,
  target: browserOpenTargetSchema,
  until: browserWaitSpecSchema.optional(),
}).strict()

export const browserNonWaitActionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('navigate'),
    url: browserUrlSchema,
  }).strict(),
  z.object({ kind: z.literal('back') }).strict(),
  z.object({ kind: z.literal('forward') }).strict(),
  z.object({ kind: z.literal('reload') }).strict(),
  z.object({ kind: z.literal('stop') }).strict(),
  z.object({
    kind: z.literal('click'),
    ref: browserElementRefSchema,
  }).strict(),
  z.object({
    kind: z.literal('fill'),
    ref: browserElementRefSchema,
    text: browserActionTextSchema,
  }).strict(),
  z.object({
    kind: z.literal('type'),
    ref: browserElementRefSchema,
    text: browserActionTextSchema.min(1),
  }).strict(),
  z.object({
    key: z.enum(BROWSER_PRESS_KEYS),
    kind: z.literal('press'),
    ref: browserElementRefSchema.optional(),
  }).strict(),
  z.object({
    kind: z.literal('select'),
    ref: browserElementRefSchema,
    values: z.array(z.string().max(4_096))
      .min(1)
      .max(32)
      .refine(values => new Set(values).size === values.length),
  }).strict(),
  z.object({
    amount: z.enum(['page', 'half-page']),
    direction: z.enum(['up', 'down']),
    kind: z.literal('scroll'),
    ref: browserElementRefSchema.optional(),
  }).strict(),
])

export const browserWaitActionSchema = z.discriminatedUnion('condition', [
  browserPageReadyWaitSpecSchema.extend({ kind: z.literal('wait') }),
  browserUrlChangedWaitSpecSchema.extend({ kind: z.literal('wait') }),
  browserUrlMatchesWaitSpecSchema.extend({ kind: z.literal('wait') }),
  browserTextVisibleWaitSpecSchema.extend({ kind: z.literal('wait') }),
  browserDomStableWaitSpecSchema.extend({ kind: z.literal('wait') }),
  z.object({
    condition: z.literal('ref-visible'),
    kind: z.literal('wait'),
    ref: browserElementRefSchema,
    timeoutMs: browserWaitTimeoutMsSchema,
  }).strict(),
  z.object({
    condition: z.literal('ref-hidden'),
    kind: z.literal('wait'),
    ref: browserElementRefSchema,
    timeoutMs: browserWaitTimeoutMsSchema,
  }).strict(),
])

export const browserActionSchema = z.union([
  browserNonWaitActionSchema,
  browserWaitActionSchema,
])

export const browserCapabilityActParamsShape = {
  action: browserActionSchema,
  documentRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  frameId: browserFrameIdSchema.optional(),
  observationId: browserIdSchema,
  pageId: browserIdSchema,
}

export const browserCapabilityActParamsSchema = z.object(
  browserCapabilityActParamsShape,
).strict().superRefine(validateBrowserActionFrame)

export const browserActParamsSchema = z.object({
  owner: browserPageOwnerSchema.optional(),
  ...browserCapabilityActParamsShape,
  controlEpoch: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  sessionId: browserIdSchema,
}).strict().superRefine(validateBrowserActionFrame)

export const browserValidateActionParamsSchema = z.object({
  owner: browserPageOwnerSchema.optional(),
  ...browserCapabilityActParamsShape,
  sessionId: browserIdSchema,
}).strict().superRefine(validateBrowserActionFrame)

export function validateBrowserActionFrame(
  input: { action: z.infer<typeof browserActionSchema>, frameId?: string },
  context: z.RefinementCtx,
): void {
  const hasTarget = getBrowserActionRef(input.action) !== undefined
  if (hasTarget === Boolean(input.frameId))
    return
  context.addIssue({
    code: 'custom',
    message: hasTarget
      ? 'Targeted browser actions must include the observed frame id'
      : 'Targetless browser actions cannot include a frame id',
    path: ['frameId'],
  })
}

export function getBrowserActionRef(
  action: z.infer<typeof browserActionSchema>,
): string | undefined {
  switch (action.kind) {
    case 'click':
    case 'fill':
    case 'type':
    case 'select':
      return action.ref
    case 'press':
    case 'scroll':
      return action.ref
    case 'wait':
      return 'ref' in action ? action.ref : undefined
    default:
      return undefined
  }
}

export type BrowserOpenTarget = z.infer<typeof browserOpenTargetSchema>

export type BrowserOpenParams = z.infer<typeof browserOpenParamsSchema>

export type BrowserWaitCondition = z.infer<typeof browserWaitConditionSchema>

export type BrowserWaitSpec = z.infer<typeof browserWaitSpecSchema>

export type BrowserWaitOutcome = z.infer<typeof browserWaitOutcomeSchema>

export type BrowserAction = z.infer<typeof browserActionSchema>

export type BrowserCapabilityActParams = z.infer<typeof browserCapabilityActParamsSchema>

export type BrowserActParams = z.infer<typeof browserActParamsSchema>

export type BrowserValidateActionParams = z.infer<typeof browserValidateActionParamsSchema>
