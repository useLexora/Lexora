import { z } from 'zod'
import { BROWSER_MAX_OBSERVATION_ELEMENT_LIMIT, BROWSER_MAX_OBSERVATION_TEXT_BYTES, BROWSER_MAX_SCREENSHOT_BYTES, browserElementRefSchema, browserFrameIdSchema, browserIdSchema, browserRuntimeUrlSchema } from './primitives'

export function getBrowserObservationTextByteLength(observation: object): number {
  return new TextEncoder().encode(JSON.stringify(observation)).byteLength
}

export const browserSnapshotOptionsSchema = z.object({
  mode: z.enum(['semantic', 'screenshot']).optional(),
  query: z.string().trim().min(1).max(256).optional(),
  selector: z.string().trim().min(1).max(512).optional(),
  maxElements: z.number().int().min(1).max(BROWSER_MAX_OBSERVATION_ELEMENT_LIMIT).optional(),
}).strict()

export const browserObserveParamsSchema = browserSnapshotOptionsSchema.extend({
  pageId: browserIdSchema,
  sessionId: browserIdSchema,
})

export const observedStringSchema = browserFrameIdSchema

export const observedStringListSchema = z.array(observedStringSchema).max(32)

export const browserObservationTruncationReasonSchema = z.enum([
  'element-limit',
  'frame-limit',
  'frame-unavailable',
  'text-limit',
])

export const browserScreenshotFallbackReasonSchema = z.enum([
  'explicit-request',
  'semantic-content-empty',
  'semantic-content-truncated',
  'visual-content',
])

export const browserObservationTruncationSchema = z.object({
  reasons: z.array(browserObservationTruncationReasonSchema)
    .min(1)
    .max(4)
    .refine(reasons => new Set(reasons).size === reasons.length),
  suggestedMaxElements: z.number()
    .int()
    .min(1)
    .max(BROWSER_MAX_OBSERVATION_ELEMENT_LIMIT)
    .optional(),
}).strict()

export const browserScreenshotRefSchema = z.object({
  byteLength: z.number().int().min(8).max(BROWSER_MAX_SCREENSHOT_BYTES),
  height: z.number().int().positive().max(32_768),
  mimeType: z.literal('image/png'),
  reasons: z.array(browserScreenshotFallbackReasonSchema)
    .min(1)
    .max(3)
    .refine(reasons => new Set(reasons).size === reasons.length),
  screenshotId: browserIdSchema,
  width: z.number().int().positive().max(32_768),
}).strict()

export const browserObservedElementSchema = z.object({
  actions: observedStringListSchema,
  description: z.string().max(1_024).optional(),
  frameId: observedStringSchema,
  inputMode: z.literal('human').optional(),
  level: z.number().int().positive().max(128).optional(),
  name: z.string().max(1_024),
  ref: browserElementRefSchema,
  role: observedStringSchema,
  states: observedStringListSchema,
  value: z.string().max(4_096).optional(),
  valueState: z.enum(['empty', 'present', 'redacted']).optional(),
}).strict().superRefine((element, context) => {
  if (element.inputMode === 'human') {
    if (element.actions.length > 0) {
      context.addIssue({
        code: 'custom',
        message: 'Human-only browser inputs cannot expose agent actions',
        path: ['actions'],
      })
    }
    if (element.valueState !== 'empty' && element.valueState !== 'redacted') {
      context.addIssue({
        code: 'custom',
        message: 'Human-only browser inputs must expose only filled state',
        path: ['valueState'],
      })
    }
  }
  if (element.valueState === 'redacted' && element.inputMode !== 'human') {
    context.addIssue({
      code: 'custom',
      message: 'Redacted browser inputs must require human input',
      path: ['inputMode'],
    })
  }
  if (element.value !== undefined && element.valueState !== 'present') {
    context.addIssue({
      code: 'custom',
      message: 'Only present browser elements can include a value',
      path: ['value'],
    })
  }
  if (
    element.valueState === 'present'
    && (element.value === undefined || element.value.length === 0)
  ) {
    context.addIssue({
      code: 'custom',
      message: 'Present browser elements must include a non-empty value',
      path: ['value'],
    })
  }
})

export const browserObservationSchema = z.object({
  documentRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  elements: z.array(browserObservedElementSchema).max(BROWSER_MAX_OBSERVATION_ELEMENT_LIMIT),
  observationId: browserIdSchema,
  pageId: browserIdSchema,
  mode: z.enum(['semantic', 'screenshot']).optional(),
  screenshot: browserScreenshotRefSchema.optional(),
  screenshotIssue: z.enum(['sensitive-input', 'privacy-unavailable', 'capture-failed']).optional(),
  semanticUnavailable: z.literal(true).optional(),
  sessionId: browserIdSchema,
  status: z.enum(['error', 'loading', 'ready']),
  title: z.string().max(512),
  truncated: z.boolean(),
  truncation: browserObservationTruncationSchema.optional(),
  url: z.union([z.literal('about:blank'), browserRuntimeUrlSchema]),
}).strict().superRefine((observation, context) => {
  if (observation.truncated !== Boolean(observation.truncation)) {
    context.addIssue({
      code: 'custom',
      message: 'Truncated browser observations must describe their truncation',
      path: ['truncation'],
    })
  }
  if (
    getBrowserObservationTextByteLength(observation)
    > BROWSER_MAX_OBSERVATION_TEXT_BYTES
  ) {
    context.addIssue({
      code: 'custom',
      message: 'Browser observation exceeds the serialized text limit',
      path: ['elements'],
    })
  }
})

export type BrowserObserveParams = z.infer<typeof browserObserveParamsSchema>

export type BrowserObservedElement = z.infer<typeof browserObservedElementSchema>

export type BrowserObservationTruncation = z.infer<typeof browserObservationTruncationSchema>

export type BrowserScreenshotRef = z.infer<typeof browserScreenshotRefSchema>

export type BrowserObservation = z.infer<typeof browserObservationSchema>

export const browserScreenshotReadParamsSchema = z.object({
  documentRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  observationId: browserIdSchema,
  pageId: browserIdSchema,
  screenshotId: browserIdSchema,
  sessionId: browserIdSchema,
}).strict()

export const browserScreenshotImageSchema = z.object({
  data: z.string().min(12).max(Math.ceil(BROWSER_MAX_SCREENSHOT_BYTES / 3) * 4).regex(/^[A-Z0-9+/]+={0,2}$/i).refine(data => data.length % 4 === 0 && data.length / 4 * 3 - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0) <= BROWSER_MAX_SCREENSHOT_BYTES),
  mimeType: z.literal('image/png'),
}).strict()

export type BrowserScreenshotReadParams = z.infer<typeof browserScreenshotReadParamsSchema>
export type BrowserScreenshotImage = z.infer<typeof browserScreenshotImageSchema>
