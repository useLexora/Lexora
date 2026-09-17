import type { DesktopBrowserAttachGuestInput, DesktopBrowserEnsureSessionInput, DesktopBrowserGuestDescriptor, DesktopBrowserNavigateInput, DesktopBrowserOpenArtifactInput, DesktopBrowserSecurityState, DesktopBrowserSessionInput, DesktopBrowserSetProfileModeInput, DesktopBrowserSetSurfaceInput, DesktopBrowserState } from './browserDesktopApi'
import { z } from 'zod'
import { DESKTOP_BROWSER_ERROR_CODES, DESKTOP_BROWSER_PROFILE_MODES, DESKTOP_BROWSER_SECURITY_KINDS } from './browserDesktopApi'
import { browserZoomFactorSchema } from './browserPreferences'
import { BROWSER_FAILURE_REASONS } from './primitives'

const browserConversationIdSchema = z.string().trim().min(1).max(128)
const browserSessionIdSchema = z.uuid()
const browserUrlSchema = z.string().trim().min(1).max(4_096).refine((value) => {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  }
  catch {
    return false
  }
})
const browserPageUrlSchema = z.string().trim().min(1).max(32_768).refine((value) => {
  try {
    const url = new URL(value)
    return url.protocol === 'file:' || url.protocol === 'http:' || url.protocol === 'https:'
  }
  catch {
    return false
  }
})
const browserOriginSchema = z.string().min(1).max(4_096).refine((value) => {
  if (value === 'file://')
    return true
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:')
      && url.origin === value
  }
  catch {
    return false
  }
})

export const browserEnsureSessionInputSchema: z.ZodType<DesktopBrowserEnsureSessionInput>
  = z.object({ conversationId: browserConversationIdSchema.nullable(), tabId: z.string().trim().min(1).max(128).optional() }).strict().refine(input => input.conversationId !== null || Boolean(input.tabId && input.tabId !== 'default'))

export const browserNavigateInputSchema: z.ZodType<DesktopBrowserNavigateInput> = z.object({
  sessionId: browserSessionIdSchema,
  url: browserUrlSchema,
}).strict()

export const browserOpenArtifactInputSchema: z.ZodType<DesktopBrowserOpenArtifactInput>
  = z.object({
    artifactId: z.string().trim().min(1).max(256),
    sessionId: browserSessionIdSchema,
  }).strict()

export const browserAttachGuestInputSchema: z.ZodType<DesktopBrowserAttachGuestInput>
  = z.object({
    sessionId: browserSessionIdSchema,
    webContentsId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  }).strict()

export const desktopBrowserGuestDescriptorSchema: z.ZodType<DesktopBrowserGuestDescriptor>
  = z.object({
    partition: z.string().trim().min(1).max(256),
    sessionId: browserSessionIdSchema,
  }).strict()

export const desktopBrowserGuestDescriptorsSchema = z.array(desktopBrowserGuestDescriptorSchema)
  .max(4)

export const browserSetSurfaceInputSchema: z.ZodType<DesktopBrowserSetSurfaceInput>
  = z.object({
    sessionId: browserSessionIdSchema,
    visible: z.boolean(),
  }).strict()

export const browserSessionInputSchema: z.ZodType<DesktopBrowserSessionInput> = z.object({
  sessionId: browserSessionIdSchema,
}).strict()

export const browserSetZoomFactorInputSchema = z.object({
  sessionId: browserSessionIdSchema,
  zoomFactor: browserZoomFactorSchema.nullable(),
}).strict()

export const browserSetProfileModeInputSchema: z.ZodType<DesktopBrowserSetProfileModeInput>
  = z.object({
    profileMode: z.enum(DESKTOP_BROWSER_PROFILE_MODES),
    sessionId: browserSessionIdSchema,
  }).strict()

const desktopBrowserSecurityStateSchema: z.ZodType<DesktopBrowserSecurityState>
  = z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('blank'),
      origin: z.null(),
    }).strict(),
    z.object({
      kind: z.enum(DESKTOP_BROWSER_SECURITY_KINDS.filter(kind => kind !== 'blank')),
      origin: browserOriginSchema,
    }).strict(),
  ])

export const desktopBrowserStateSchema: z.ZodType<DesktopBrowserState> = z.object({
  zoomFactor: browserZoomFactorSchema,
  canGoBack: z.boolean(),
  canGoForward: z.boolean(),
  controller: z.enum(['agent', 'human']),
  controlEpoch: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  conversationId: browserConversationIdSchema.nullable(),
  error: z.object({
    code: z.enum(DESKTOP_BROWSER_ERROR_CODES),
    message: z.string().max(1_024),
    reason: z.enum(BROWSER_FAILURE_REASONS).optional(),
  }).strict().nullable(),
  pageId: z.uuid(),
  profileMode: z.enum(DESKTOP_BROWSER_PROFILE_MODES),
  security: desktopBrowserSecurityStateSchema,
  sessionId: browserSessionIdSchema,
  status: z.enum(['error', 'idle', 'loading', 'ready']),
  title: z.string().max(512),
  url: z.union([z.literal('about:blank'), browserPageUrlSchema]),
  visible: z.boolean(),
}).strict()
