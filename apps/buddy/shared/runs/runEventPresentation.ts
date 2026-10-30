import { z } from 'zod'
import { BROWSER_ACTION_KINDS } from '../browser'
import { BUDDY_ATTACHMENT_COUNT_LIMIT } from '../conversation/attachmentPolicy'
import { imageSourceSchema } from '../images/imagePreferences'

const legacyDirectoryScopeRelationSchema = z.enum([
  'ancestor',
  'descendant',
  'exact',
  'unrelated',
])

const previewSchema = z.object({
  description: z.string().min(1).max(4 * 1024).nullable(),
  output: z.string().max(64 * 1024).nullable(),
  truncated: z.boolean(),
}).strict()

const pathSchema = z.string().min(1).max(4_096)

export const buddyToolPresentationSchema = z.discriminatedUnion('card', [
  previewSchema.extend({
    card: z.literal('session'),
    sessionId: z.string().min(1).max(128).nullable(),
    title: z.string().max(200).nullable(),
    target: z.string().max(4096).nullable(),
  }).strict(),
  previewSchema.extend({
    card: z.literal('web'),
    operation: z.enum(['search', 'fetch']),
    target: z.string().max(4096),
    provider: z.string().max(256).nullable(),
  }).strict(),
  previewSchema.extend({
    argumentNames: z.array(z.string().min(1).max(256)).max(32),
    card: z.literal('generic'),
  }).strict(),
  previewSchema.extend({
    card: z.literal('terminal'),
    command: z.string().max(4 * 1024),
    cwd: pathSchema.nullable(),
    exitCode: z.number().int().nullable(),
    signal: z.string().min(1).max(128).nullable(),
  }).strict(),
  previewSchema.extend({
    card: z.literal('read'),
    language: z.string().min(1).max(128).nullable(),
    lineStart: z.number().int().positive(),
    path: pathSchema,
  }).strict(),
  previewSchema.extend({
    card: z.literal('search'),
    glob: z.string().min(1).max(4 * 1024).nullable(),
    path: pathSchema.nullable(),
    query: z.string().max(4 * 1024),
  }).strict(),
  previewSchema.extend({
    card: z.literal('diff'),
    diff: z.string().max(64 * 1024).nullable(),
    firstChangedLine: z.number().int().positive().nullable(),
    operation: z.enum(['created', 'edited']),
    path: pathSchema,
  }).strict(),
  previewSchema.extend({
    argumentNames: z.array(z.string().min(1).max(256)).max(32),
    card: z.literal('connector'),
    connector: z.string().min(1).max(256),
    tool: z.string().min(1).max(256),
  }).strict(),
  z.object({
    artifactIds: z.array(z.string().min(1).max(256)).max(BUDDY_ATTACHMENT_COUNT_LIMIT),
    card: z.literal('image'),
    description: z.string().min(1).max(4 * 1024).nullable(),
    generatedCount: z.number().int().nonnegative().nullable(),
    source: imageSourceSchema.optional(),
    prompt: z.string().min(1).max(32 * 1024).nullable(),
    reference: z.discriminatedUnion('mode', [
      z.object({
        resourceIds: z.array(z.string().min(1).max(256)).max(4),
        mode: z.literal('resources'),
      }).strict(),
      z.object({
        mode: z.literal('latest'),
      }).strict(),
    ]).nullable(),
    status: z.enum(['completed', 'failed', 'running']),
  }).strict(),
  z.object({
    card: z.literal('pet'),
    description: z.string().min(1).max(4 * 1024).nullable(),
    macro: z.string().min(1).max(256),
    status: z.string().min(1).max(256),
  }).strict(),
  z.object({
    automationId: z.string().min(1).max(256).nullable(),
    card: z.literal('automation'),
    itemCount: z.number().int().nonnegative().nullable(),
    name: z.string().min(1).max(80).nullable(),
    nextRunAt: z.iso.datetime().nullable(),
    occurrenceId: z.string().min(1).max(256).nullable(),
    operation: z.enum(['list', 'get', 'upsert', 'pause', 'resume', 'delete', 'run_now']),
    status: z.string().min(1).max(256).nullable(),
  }).strict(),
  z.object({
    actionKind: z.enum(BROWSER_ACTION_KINDS).nullable(),
    card: z.literal('browser'),
    description: z.null(),
    documentRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
    elementCount: z.number().int().nonnegative().max(400).nullable(),
    errorCode: z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/).nullable(),
    fieldType: z.enum(['selection', 'text']).nullable(),
    inputLength: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
    observationTruncated: z.boolean().nullable(),
    operation: z.enum(['act', 'open', 'read', 'snapshot']),
    origin: z.string().min(1).max(4_096).refine((value) => {
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
    }).nullable(),
    output: z.null(),
    pageId: z.uuid().nullable(),
    pageStatus: z.enum(['error', 'idle', 'loading', 'ready']).nullable(),
    pathname: z.enum(['/', '/[redacted]']).nullable(),
    sessionId: z.uuid().nullable(),
    status: z.enum(['completed', 'failed', 'running']),
    truncated: z.literal(false),
  }).strict().superRefine((presentation, context) => {
    if ((presentation.origin === null) !== (presentation.pathname === null)) {
      context.addIssue({
        code: 'custom',
        message: 'Browser origin and pathname must be projected together',
        path: ['pathname'],
      })
    }
    if ((presentation.sessionId === null) !== (presentation.pageId === null)) {
      context.addIssue({
        code: 'custom',
        message: 'Browser session and page identity must be projected together',
        path: ['pageId'],
      })
    }
    if ((presentation.status === 'failed') !== (presentation.errorCode !== null)) {
      context.addIssue({
        code: 'custom',
        message: 'Browser failures must include one stable error code',
        path: ['errorCode'],
      })
    }
    if (
      presentation.operation !== 'snapshot'
      && (
        presentation.documentRevision !== null
        || presentation.elementCount !== null
        || presentation.observationTruncated !== null
      )
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Only browser snapshot events can include observation metadata',
        path: ['operation'],
      })
    }
    if (presentation.operation !== 'act') {
      if (
        presentation.actionKind !== null
        || presentation.fieldType !== null
        || presentation.inputLength !== null
      ) {
        context.addIssue({
          code: 'custom',
          message: 'Only browser act events can include action metadata',
          path: ['operation'],
        })
      }
      return
    }
    const expectedFieldType = presentation.actionKind === 'fill'
      || presentation.actionKind === 'type'
      ? 'text'
      : presentation.actionKind === 'select'
        ? 'selection'
        : null
    if (
      presentation.fieldType !== expectedFieldType
      || (expectedFieldType === null) !== (presentation.inputLength === null)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Browser input metadata must match the action kind',
        path: ['fieldType'],
      })
    }
  }),
  z.object({
    authorizedRoot: pathSchema.nullable(),
    card: z.literal('directory-authorization'),
    coveredDirectoryCount: z.number().int().nonnegative().max(32),
    errorCode: z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/).nullable(),
    grantStatus: z.enum([
      'already_authorized',
      'already_covered',
      'expanded',
      'granted',
    ]).nullable(),
    relation: legacyDirectoryScopeRelationSchema.nullable(),
    requestSatisfied: z.boolean().nullable(),
    requestedRoot: pathSchema.nullable(),
    selectedRoot: pathSchema.nullable(),
    status: z.enum([
      'authorized',
      'awaiting-authorization',
      'cancelled',
      'failed',
      'scope-changed',
    ]),
  }).strict(),
  previewSchema.extend({
    action: z.enum([
      'kill-process',
      'restart-service',
      'start-service',
      'stop-service',
      'terminate-process',
    ]),
    card: z.literal('system'),
    status: z.string().min(1).max(256).nullable(),
    target: z.string().min(1).max(256).nullable(),
    verified: z.boolean().nullable(),
  }).strict(),
])

export const buddyToolPresentationDeltaSchema = z.object({
  card: z.literal('terminal'),
  outputDelta: z.string().max(64 * 1024),
  outputStart: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  truncated: z.boolean(),
}).strict()

export type BuddyToolPresentation = z.infer<typeof buddyToolPresentationSchema>
export type BuddyToolPresentationDelta = z.infer<typeof buddyToolPresentationDeltaSchema>
