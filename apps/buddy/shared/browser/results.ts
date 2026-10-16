import { z } from 'zod'
import { browserWaitOutcomeSchema } from './actions'
import { browserObservationSchema, browserScreenshotImageSchema } from './observation'
import { browserActionKindSchema, browserErrorSchema } from './primitives'
import { browserReadContentSchema } from './reading'
import { browserControlLeaseSchema, browserStateSnapshotSchema } from './session'

export const browserFailureResultSchema = z.object({
  error: browserErrorSchema,
  ok: z.literal(false),
}).strict()

export const browserOpenResultSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    state: browserStateSnapshotSchema,
    until: browserWaitOutcomeSchema.optional(),
  }).strict(),
  browserFailureResultSchema,
])

export const browserObserveResultSchema = z.discriminatedUnion('ok', [
  z.object({
    observation: browserObservationSchema,
    ok: z.literal(true),
  }).strict(),
  browserFailureResultSchema,
])

export const browserReadResultSchema = z.discriminatedUnion('ok', [
  z.object({ content: browserReadContentSchema, ok: z.literal(true) }).strict(),
  browserFailureResultSchema,
])

export type BrowserReadResult = z.infer<typeof browserReadResultSchema>

export const browserActResultSchema = z.discriminatedUnion('ok', [
  z.object({
    actionKind: browserActionKindSchema,
    observation: browserObservationSchema,
    ok: z.literal(true),
    state: browserStateSnapshotSchema,
  }).strict(),
  browserFailureResultSchema,
])

export const browserValidateActionResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true) }).strict(),
  browserFailureResultSchema,
])

export const browserAcquireControlResultSchema = z.discriminatedUnion('ok', [
  z.object({
    lease: browserControlLeaseSchema,
    ok: z.literal(true),
  }).strict(),
  browserFailureResultSchema,
])

export const browserReleaseControlResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true) }).strict(),
  browserFailureResultSchema,
])

export const browserStateResultSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    state: browserStateSnapshotSchema,
  }).strict(),
  browserFailureResultSchema,
])

export const browserCloseResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true) }).strict(),
  browserFailureResultSchema,
])

export type BrowserOpenResult = z.infer<typeof browserOpenResultSchema>

export type BrowserObserveResult = z.infer<typeof browserObserveResultSchema>

export type BrowserActResult = z.infer<typeof browserActResultSchema>

export type BrowserValidateActionResult = z.infer<typeof browserValidateActionResultSchema>

export type BrowserAcquireControlResult = z.infer<typeof browserAcquireControlResultSchema>

export type BrowserReleaseControlResult = z.infer<typeof browserReleaseControlResultSchema>

export type BrowserStateResult = z.infer<typeof browserStateResultSchema>

export type BrowserCloseResult = z.infer<typeof browserCloseResultSchema>

export const browserScreenshotReadResultSchema = z.discriminatedUnion('ok', [
  z.object({ image: browserScreenshotImageSchema, ok: z.literal(true) }).strict(),
  browserFailureResultSchema,
])

export type BrowserScreenshotReadResult = z.infer<typeof browserScreenshotReadResultSchema>
