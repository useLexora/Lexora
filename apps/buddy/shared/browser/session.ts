import { z } from 'zod'
import { browserConversationIdSchema, browserErrorSchema, browserIdSchema, browserOriginSchema, browserRuntimeUrlSchema } from './primitives'

export const browserPageOwnerSchema = z.object({
  runId: z.string().min(1).max(128),
  buddyId: z.string().min(1).max(128),
}).strict()

export type BrowserPageOwner = z.infer<typeof browserPageOwnerSchema>

export function browserAgentTabId(runId: string): string {
  return `agent:${runId}`
}

export const browserAcquireControlParamsSchema = z.object({
  owner: browserPageOwnerSchema.optional(),
  pageId: browserIdSchema,
  sessionId: browserIdSchema,
}).strict()

export const browserReleaseControlParamsSchema = z.object({
  owner: browserPageOwnerSchema.optional(),
  controlEpoch: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  pageId: browserIdSchema,
  sessionId: browserIdSchema,
}).strict()

export const browserControlLeaseSchema = z.object({
  owner: browserPageOwnerSchema.optional(),
  controller: z.literal('agent'),
  controlEpoch: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  pageId: browserIdSchema,
  sessionId: browserIdSchema,
}).strict()

export const browserCancelParamsSchema = z.object({
  conversationId: browserConversationIdSchema,
  owner: browserPageOwnerSchema,
}).strict()

export const browserSessionParamsSchema = z.object({
  owner: browserPageOwnerSchema.optional(),
  sessionId: browserIdSchema,
}).strict()

export const browserSecurityStateSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('blank'),
    origin: z.null(),
  }).strict(),
  z.object({
    kind: z.enum(['certificate-error', 'insecure', 'local', 'secure']),
    origin: browserOriginSchema,
  }).strict(),
])

export const browserStateSnapshotSchema = z.object({
  owner: browserPageOwnerSchema.optional(),
  canGoBack: z.boolean(),
  canGoForward: z.boolean(),
  controller: z.enum(['agent', 'human']),
  controlEpoch: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  conversationId: browserConversationIdSchema,
  error: browserErrorSchema.nullable(),
  pageId: browserIdSchema,
  profileMode: z.enum(['default', 'incognito']),
  security: browserSecurityStateSchema,
  sessionId: browserIdSchema,
  status: z.enum(['error', 'idle', 'loading', 'ready']),
  title: z.string().max(512),
  url: z.union([z.literal('about:blank'), browserRuntimeUrlSchema]),
  visible: z.boolean(),
}).strict()

export type BrowserAcquireControlParams = z.infer<typeof browserAcquireControlParamsSchema>

export type BrowserReleaseControlParams = z.infer<typeof browserReleaseControlParamsSchema>

export type BrowserControlLease = z.infer<typeof browserControlLeaseSchema>

export type BrowserSessionParams = z.infer<typeof browserSessionParamsSchema>

export type BrowserStateSnapshot = z.infer<typeof browserStateSnapshotSchema>
