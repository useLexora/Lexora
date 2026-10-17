import { z } from 'zod'
import { BROWSER_ACTION_KINDS, BROWSER_PRESS_KEYS } from '../browser/primitives'
import {
  BUDDY_DEFAULT_EXECUTION_PROFILE,
  BUDDY_EXECUTION_PROFILES,
} from './executionProfile'

import { sandboxDirectoryRequestSchema, sandboxNetworkTargetSchema } from './shellSandbox'

const MAX_COMMAND_SOURCE_LENGTH = 16 * 1024
const MAX_COMMAND_REVIEW_LENGTH = 4 * 1024
const MAX_ARGUMENT_NAMES = 32
const MAX_ARGUMENT_VALUES_LENGTH = 8 * 1024
export const MAX_TARGET_PATHS = 32

export const SHELL_APPROVAL_REASONS = [
  'unknown-command',
  'unsupported-syntax',
  'unsafe-arguments',
  'git-external-program',
  'git-config-unavailable',
  'sensitive-path',
  'system-mutation',
  'forced-confirmation',
  'manual-policy',
  'sandbox-bypass',
] as const
export type ShellApprovalReason = typeof SHELL_APPROVAL_REASONS[number]

const shellApprovalContextSchema = z.object({
  boundary: z.enum(['sandbox', 'host']).optional(),
  cwd: z.string().min(1).max(4_096),
  reason: z.enum(SHELL_APPROVAL_REASONS),
}).strict()
export type ShellApprovalContext = z.infer<typeof shellApprovalContextSchema>

export const APPROVAL_REVIEW_KINDS = [
  'read',
  'render',
  'write',
  'delete',
  'shell',
  'system',
  'network',
  'browser',
  'mcp',
  'automation',
] as const

export const APPROVAL_REUSE_SCOPES = ['operation', 'source', 'turn'] as const
export type ApprovalReuseScope = typeof APPROVAL_REUSE_SCOPES[number]
export const APPROVAL_GRANT_SCOPES = ['once', ...APPROVAL_REUSE_SCOPES] as const
export type ApprovalGrantScope = typeof APPROVAL_GRANT_SCOPES[number]

const approvalReuseScopesSchema = z.array(z.enum(APPROVAL_REUSE_SCOPES)).max(APPROVAL_REUSE_SCOPES.length)

const toolNameSchema = z.string().trim().min(1).max(256)
const systemActionSchema = z.enum([
  'kill-process',
  'restart-service',
  'start-service',
  'stop-service',
  'terminate-process',
])
const systemActionTargetSchema = z.object({
  displayName: z.string().trim().min(1).max(256),
  pid: z.number().int().positive().optional(),
  startedAt: z.iso.datetime().optional(),
  serviceId: z.string().trim().min(1).max(256).optional(),
}).strict()

const automationOperationSchema = z.enum([
  'upsert',
  'pause',
  'resume',
  'delete',
  'run_now',
])

const browserApprovalEffectSchema = z.enum([
  'account-change',
  'authorize',
  'delete',
  'publish',
  'purchase',
  'send',
  'submit',
])
const browserApprovalOriginSchema = z.union([
  z.literal('about:blank'),
  z.string().trim().min(1).max(4_096).refine((value) => {
    try {
      const url = new URL(value)
      return (url.protocol === 'http:' || url.protocol === 'https:')
        && url.origin === value
    }
    catch {
      return false
    }
  }),
])

export const approvalReviewPayloadSchema = z.discriminatedUnion('card', [
  sandboxDirectoryRequestSchema.extend({
    allowForTurn: z.boolean().default(false),
    card: z.literal('sandbox-directory'),
    reuseScopes: approvalReuseScopesSchema.optional(),
    scope: z.literal('run'),
    toolName: z.literal('lexora_authorize_directory'),
  }).strict(),
  sandboxNetworkTargetSchema.extend({
    allowForTurn: z.boolean().default(false),
    card: z.literal('sandbox-network'),
    command: z.string().max(MAX_COMMAND_REVIEW_LENGTH),
    reuseScopes: approvalReuseScopesSchema.optional(),
    toolName: z.enum(['bash', 'powershell']),
  }).strict(),
  z.object({
    allowForTurn: z.boolean().default(true),
    card: z.literal('shell'),
    command: z.string().max(MAX_COMMAND_REVIEW_LENGTH),
    context: shellApprovalContextSchema.optional(),
    reuseScopes: approvalReuseScopesSchema.optional(),
    toolName: toolNameSchema,
  }).strict(),
  z.object({
    access: z.enum(['delete', 'read', 'render', 'write']),
    allowForTurn: z.boolean().default(true),
    card: z.literal('paths'),
    grant: z.object({
      owner: z.enum(['conversation', 'space']),
      root: z.string().trim().min(1).max(4_096),
    }).strict().nullable(),
    reuseScopes: approvalReuseScopesSchema.optional(),
    targets: z.array(z.object({
      path: z.string().trim().min(1).max(4_096),
      zone: z.enum(['granted', 'outside', 'sensitive', 'workspace']),
    }).strict()).min(1).max(MAX_TARGET_PATHS),
    toolName: toolNameSchema,
  }).strict(),
  z.object({
    allowForTurn: z.boolean().default(true),
    argumentNames: z.array(z.string().min(1).max(256)).max(MAX_ARGUMENT_NAMES),
    card: z.literal('arguments'),
    parameters: z.array(z.object({
      name: z.string().min(1).max(256),
      value: z.string().max(MAX_ARGUMENT_VALUES_LENGTH),
    }).strict()).max(MAX_ARGUMENT_NAMES).optional(),
    reuseScopes: approvalReuseScopesSchema.optional(),
    toolName: toolNameSchema,
  }).strict(),
  z.object({
    allowForTurn: z.boolean().default(true),
    card: z.literal('network-target'),
    reuseScopes: approvalReuseScopesSchema.optional(),
    target: z.string().trim().min(1).max(4_096),
    toolName: toolNameSchema,
  }).strict(),
  z.object({
    allowForTurn: z.boolean().default(true),
    card: z.literal('web'),
    operation: z.enum(['search', 'fetch']),
    provider: z.string().trim().min(1).max(256).nullable(),
    reuseScopes: approvalReuseScopesSchema.optional(),
    target: z.string().trim().min(1).max(4_096),
    toolName: z.enum(['lexora_web_search', 'lexora_web_fetch']),
  }).strict(),
  z.object({
    action: systemActionSchema,
    allowForTurn: z.boolean().default(true),
    card: z.literal('system-action'),
    effect: z.string().trim().min(1).max(512),
    expiresAt: z.iso.datetime(),
    interruption: z.enum(['application', 'network', 'none', 'service']),
    reason: z.string().trim().min(1).max(512),
    reuseScopes: approvalReuseScopesSchema.optional(),
    target: systemActionTargetSchema,
    toolName: toolNameSchema,
  }).strict(),
  z.object({
    allowForTurn: z.boolean().default(false),
    card: z.literal('automation'),
    executionProfile: z.enum(BUDDY_EXECUTION_PROFILES).default(BUDDY_DEFAULT_EXECUTION_PROFILE),
    modelMode: z.string().trim().min(1).max(512),
    name: z.string().trim().min(1).max(80),
    operation: automationOperationSchema,
    spaceId: z.string().trim().min(1).max(256).nullable(),
    promptSummary: z.string().trim().min(1).max(512),
    reuseScopes: approvalReuseScopesSchema.optional(),
    scheduleSummary: z.string().trim().min(1).max(512),
    timezone: z.string().trim().min(1).max(256),
    toolName: toolNameSchema,
  }).strict(),
  z.object({
    action: z.enum(BROWSER_ACTION_KINDS),
    actionDigest: z.string().regex(/^[a-f0-9]{64}$/),
    allowForTurn: z.boolean().default(false),
    card: z.literal('browser-action'),
    documentRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    effect: browserApprovalEffectSchema.nullable(),
    key: z.enum(BROWSER_PRESS_KEYS).nullable(),
    observationId: z.uuid(),
    origin: browserApprovalOriginSchema,
    pageId: z.uuid(),
    risk: z.enum(['interaction', 'commit-like', 'unknown-commit-like']),
    reuseScopes: approvalReuseScopesSchema.optional(),
    sessionId: z.uuid(),
    targetName: z.string().max(1_024).nullable(),
    targetRole: z.string().trim().min(1).max(1_024).nullable(),
    toolName: toolNameSchema,
  }).strict().superRefine((review, context) => {
    if ((review.risk === 'commit-like') !== (review.effect !== null)) {
      context.addIssue({
        code: 'custom',
        message: 'Known browser commitments require one stable effect',
        path: ['effect'],
      })
    }
    if ((review.action === 'press') !== (review.key !== null)) {
      context.addIssue({
        code: 'custom',
        message: 'Browser approval keys must match the action kind',
        path: ['key'],
      })
    }
  }),
])

export type ApprovalReviewPayload = z.infer<typeof approvalReviewPayloadSchema>
export type ApprovalReviewKind = typeof APPROVAL_REVIEW_KINDS[number]
export type AutomationApprovalReview = Extract<
  ApprovalReviewPayload,
  { card: 'automation' }
>
export type AutomationApprovalReviewInput = Omit<
  AutomationApprovalReview,
  'allowForTurn' | 'card' | 'reuseScopes' | 'toolName'
>
export type BrowserApprovalReview = Extract<
  ApprovalReviewPayload,
  { card: 'browser-action' }
>
export type BrowserApprovalReviewInput = Omit<
  BrowserApprovalReview,
  'allowForTurn' | 'card' | 'reuseScopes' | 'toolName'
>
export type PathApprovalReview = Extract<
  ApprovalReviewPayload,
  { card: 'paths' }
>
export type PathApprovalReviewInput = Omit<
  PathApprovalReview,
  'allowForTurn' | 'card' | 'reuseScopes' | 'toolName'
>
export type SystemActionApprovalReview = Extract<
  ApprovalReviewPayload,
  { card: 'system-action' }
>
export type SystemActionApprovalReviewInput = Omit<
  SystemActionApprovalReview,
  'allowForTurn' | 'card' | 'reuseScopes' | 'toolName'
>

export interface CreateApprovalReviewPayloadInput {
  allowForTurn: boolean
  arguments: unknown
  automation?: AutomationApprovalReviewInput
  browser?: BrowserApprovalReviewInput
  kind: ApprovalReviewKind
  network?: z.infer<typeof sandboxNetworkTargetSchema>
  sandboxDirectory?: z.infer<typeof sandboxDirectoryRequestSchema>
  paths?: PathApprovalReviewInput
  reuseScopes?: readonly ApprovalReuseScope[]
  shell?: ShellApprovalContext
  systemAction?: SystemActionApprovalReviewInput
  toolName: string
}

export function createApprovalReviewPayload(
  input: CreateApprovalReviewPayloadInput,
): ApprovalReviewPayload {
  const reuseScopes = input.reuseScopes?.length
    ? { reuseScopes: [...new Set(input.reuseScopes)] }
    : {}
  if (input.sandboxDirectory && input.kind === input.sandboxDirectory.access) {
    return approvalReviewPayloadSchema.parse({
      ...withoutReuseScopes(input.sandboxDirectory),
      reason: redactSensitiveText(input.sandboxDirectory.reason),
      allowForTurn: input.allowForTurn,
      card: 'sandbox-directory',
      ...reuseScopes,
      scope: 'run',
      toolName: input.toolName,
    })
  }
  if (input.kind === 'network' && input.network) {
    return approvalReviewPayloadSchema.parse({
      ...withoutReuseScopes(input.network),
      allowForTurn: input.allowForTurn,
      card: 'sandbox-network',
      command: redactShellCommand(readString(input.arguments, 'command')),
      ...reuseScopes,
      toolName: input.toolName,
    })
  }
  if (input.kind === 'shell') {
    return approvalReviewPayloadSchema.parse({
      allowForTurn: input.allowForTurn,
      card: 'shell',
      command: redactShellCommand(readString(input.arguments, 'command')),
      ...(input.shell ? { context: input.shell } : {}),
      ...reuseScopes,
      toolName: input.toolName,
    })
  }
  if (
    input.kind === 'delete'
    || input.kind === 'read'
    || input.kind === 'render'
    || input.kind === 'write'
  ) {
    return approvalReviewPayloadSchema.parse({
      ...withoutReuseScopes(input.paths),
      allowForTurn: input.allowForTurn,
      card: 'paths',
      ...reuseScopes,
      toolName: input.toolName,
    })
  }
  if (input.kind === 'system' && input.systemAction) {
    return approvalReviewPayloadSchema.parse({
      ...withoutReuseScopes(input.systemAction),
      allowForTurn: input.allowForTurn,
      card: 'system-action',
      ...reuseScopes,
      toolName: input.toolName,
    })
  }
  if (input.kind === 'automation' && input.automation) {
    return approvalReviewPayloadSchema.parse({
      ...withoutReuseScopes(input.automation),
      allowForTurn: input.allowForTurn,
      card: 'automation',
      ...reuseScopes,
      toolName: input.toolName,
    })
  }
  if (input.kind === 'browser') {
    return approvalReviewPayloadSchema.parse({
      ...withoutReuseScopes(input.browser),
      allowForTurn: input.allowForTurn,
      card: 'browser-action',
      ...reuseScopes,
      toolName: input.toolName,
    })
  }
  if (
    input.kind === 'network'
    && (input.toolName === 'lexora_web_search' || input.toolName === 'lexora_web_fetch')
  ) {
    const operation = input.toolName === 'lexora_web_search' ? 'search' : 'fetch'
    return approvalReviewPayloadSchema.parse({
      allowForTurn: input.allowForTurn,
      card: 'web',
      operation,
      provider: readString(input.arguments, 'provider') || null,
      ...reuseScopes,
      target: readString(input.arguments, operation === 'search' ? 'query' : 'url'),
      toolName: input.toolName,
    })
  }
  if (input.kind === 'network' && readString(input.arguments, 'url')) {
    return approvalReviewPayloadSchema.parse({
      allowForTurn: input.allowForTurn,
      card: 'network-target',
      ...reuseScopes,
      target: normalizeNetworkTarget(readString(input.arguments, 'url')),
      toolName: input.toolName,
    })
  }
  return approvalReviewPayloadSchema.parse({
    allowForTurn: input.allowForTurn,
    argumentNames: readArgumentNames(input.arguments),
    card: 'arguments',
    parameters: readArgumentParameters(input.arguments),
    ...reuseScopes,
    toolName: input.toolName,
  })
}

export function approvalReviewPayloadMatchesKind(
  payload: ApprovalReviewPayload,
  kind: ApprovalReviewKind,
): boolean {
  if (kind === 'shell')
    return payload.card === 'shell'
  if (kind === 'delete' || kind === 'read' || kind === 'render' || kind === 'write')
    return payload.card === 'paths' || (payload.card === 'sandbox-directory' && payload.access === kind)
  if (kind === 'system')
    return payload.card === 'arguments' || payload.card === 'system-action'
  if (kind === 'automation')
    return payload.card === 'automation'
  if (kind === 'browser')
    return payload.card === 'browser-action'
  return kind === 'network'
    ? payload.card === 'arguments' || payload.card === 'network-target' || payload.card === 'web' || payload.card === 'sandbox-network'
    : payload.card === 'arguments'
}

function normalizeNetworkTarget(value: string): string {
  try {
    const url = new URL(value)
    url.hash = ''
    return url.toString()
  }
  catch {
    return value.trim()
  }
}

function withoutReuseScopes<T extends object>(value?: T): Partial<Omit<T, 'reuseScopes'>> {
  if (!value)
    return {}
  const { reuseScopes: _reuseScopes, ...review } = value as T & { reuseScopes?: unknown }
  return review
}

export function redactShellCommand(command: string): string {
  return command
    .slice(0, MAX_COMMAND_SOURCE_LENGTH)
    .replace(
      /\b([A-Z_]\w*)\s*=\s*(?:"[^"]*"|'[^']*'|\S+)/gi,
      (assignment, name: string) => isSensitiveName(name)
        ? `${name}=[redacted]`
        : assignment,
    )
    .replace(
      /(^|\s)(--?(?:api[-_]?key|token|secret|password|credential|authorization))(?:\s+|=)(?:"[^"]*"|'[^']*'|\S+)/gi,
      '$1$2=[redacted]',
    )
    .replace(/\bBearer\s+[^\s"']+/gi, 'Bearer [redacted]')
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1[redacted]@')
    .slice(0, MAX_COMMAND_REVIEW_LENGTH)
}

export function redactSensitiveText(value: string): string {
  return value
    .replace(
      /\bauthorization[ \t]*[:=][ \t]*([^\r\n]+)/gi,
      (_match, credential: string) => /^Bearer\b/i.test(credential.trim())
        ? 'Authorization: Bearer [redacted]'
        : 'Authorization: [redacted]',
    )
    .replace(/\bBearer\s+[^\s"']+/gi, 'Bearer [redacted]')
    .replace(
      /\b((?:api[-_]?key|secret|token|password|credential)\s*[:=]\s*)([^\s,;]+)/gi,
      '$1[redacted]',
    )
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1[redacted]@')
}

function isSensitiveName(name: string): boolean {
  return /API_?KEY|AUTHORIZATION|COOKIE|CREDENTIAL|PASSWORD|SECRET|SESSION|TOKEN/i.test(name)
}

function readArgumentNames(value: unknown): string[] {
  const record = readRecord(value)
  return record
    ? Object.keys(record).filter(Boolean).sort().slice(0, MAX_ARGUMENT_NAMES)
    : []
}

function readArgumentParameters(value: unknown): Array<{ name: string, value: string }> {
  const record = readRecord(value)
  if (!record)
    return []
  const entries = Object.entries(record)
    .filter(([name]) => Boolean(name))
    .sort(([left], [right]) => left.localeCompare(right))
    .slice(0, MAX_ARGUMENT_NAMES)
  let remaining = MAX_ARGUMENT_VALUES_LENGTH
  return entries.map(([name, argument], index) => {
    const preview = serializeArgumentValue(name, argument)
    const allowance = Math.max(0, Math.floor(remaining / (entries.length - index)))
    const value = truncatePreview(preview, allowance)
    remaining -= value.length
    return { name, value }
  })
}

function serializeArgumentValue(name: string, value: unknown): string {
  if (isSensitiveName(name))
    return '[redacted]'
  if (typeof value === 'string')
    return redactSensitiveText(value)
  const seen = new WeakSet<object>()
  const serialized = JSON.stringify(value, (key, nested) => {
    if (key && isSensitiveName(key))
      return '[redacted]'
    if (typeof nested === 'string')
      return redactSensitiveText(nested)
    if (typeof nested === 'bigint')
      return nested.toString()
    if (nested && typeof nested === 'object') {
      if (seen.has(nested))
        return '[circular]'
      seen.add(nested)
    }
    return nested
  }, 2)
  return serialized ?? String(value)
}

function truncatePreview(value: string, limit: number): string {
  if (value.length <= limit)
    return value
  if (limit <= 1)
    return limit === 1 ? '…' : ''
  return `${value.slice(0, limit - 1)}…`
}

function readString(value: unknown, key: string): string {
  const record = readRecord(value)
  return typeof record?.[key] === 'string' ? record[key] : ''
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}
