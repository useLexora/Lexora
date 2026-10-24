import { z } from 'zod'
import { browserElementSnapshotSchema, browserSelectionSourceSchema } from '../browser/browserSelection'
import { idSchema, timestampSchema } from '../runtime/apiValidation'
import { skillReferenceSchema } from '../skills/skillApi'
import { spaceFileTargetSchema } from '../spaces/spaceFileApi'
import { buddyLocalResourceSchema } from './localResource'
import { referenceLocatorSchema, referenceViewSourceSchema, sameReferenceJson } from './referenceMaterial'

export const buddyResourceIdSchema = z.string().regex(/^[A-Z0-9][\w-]{0,127}$/i)

export const BUDDY_QUOTE_COUNT_LIMIT = 16
export const BUDDY_QUOTE_TEXT_LIMIT = 262_144
export const BUDDY_QUOTE_TOTAL_TEXT_LIMIT = 1_048_576
export function buddyQuoteSnapshotLength(quote: { text: string, element?: unknown, locator?: unknown }): number {
  return quote.text.length + (quote.element ? JSON.stringify(quote.element).length : 0) + (quote.locator ? JSON.stringify(quote.locator).length : 0)
}
export const BUDDY_SESSION_REFERENCE_TITLE_LIMIT = 80
export const buddySessionReferenceSchema = z.object({
  id: buddyResourceIdSchema,
  title: z.string().trim().min(1).max(BUDDY_SESSION_REFERENCE_TITLE_LIMIT),
}).strict().readonly()
export const buddySessionReferencesSchema = z.array(buddySessionReferenceSchema)
  .max(16)
  .refine(references => new Set(references.map(reference => reference.id)).size === references.length, 'Duplicate session reference')
  .readonly()
export type BuddySessionReference = z.infer<typeof buddySessionReferenceSchema>

export const buddyActorReferenceSchema = z.object({
  type: z.literal('actor_ref'),
  actorId: idSchema,
  name: z.string().trim().min(1).max(80),
}).strict().readonly()
export type BuddyActorReference = z.infer<typeof buddyActorReferenceSchema>

export const buddyMessageQuoteSchema = z.object({
  id: buddyResourceIdSchema,
  text: z.string().min(1).max(BUDDY_QUOTE_TEXT_LIMIT).refine(text => text.trim().length > 0),
  textOffset: z.number().int().nonnegative().optional().describe('忽略排版空白后的 UTF-16 起始偏移，用于区分同文片段'),
  source: z.object({
    conversationId: buddyResourceIdSchema,
    branchId: buddyResourceIdSchema,
    messageId: buddyResourceIdSchema,
    role: z.enum(['user', 'assistant']),
    runId: buddyResourceIdSchema.nullable(),
  }).strict().readonly(),
}).strict().readonly()

export type BuddyMessageQuote = z.infer<typeof buddyMessageQuoteSchema>

export const buddyMessageQuotesSchema = z.array(buddyMessageQuoteSchema)
  .max(BUDDY_QUOTE_COUNT_LIMIT)
  .refine(quotes => new Set(quotes.map(quote => quote.id)).size === quotes.length)
  .readonly()

const buddyTextQuoteFields = {
  id: buddyResourceIdSchema,
  text: z.string().min(1).max(BUDDY_QUOTE_TEXT_LIMIT).refine(text => text.trim().length > 0),
  textOffset: z.number().int().nonnegative().optional(),
  range: z.object({
    startLineNumber: z.number().int().positive(),
    startColumn: z.number().int().positive(),
    endLineNumber: z.number().int().positive(),
    endColumn: z.number().int().positive(),
  }).strict().refine(range => range.endLineNumber > range.startLineNumber
    || (range.endLineNumber === range.startLineNumber && range.endColumn >= range.startColumn)).readonly().optional(),
}
const buddyFileQuoteSourceSchema = z.object({
  kind: z.literal('file'),
  title: z.string().trim().min(1).max(512),
  file: spaceFileTargetSchema.readonly(),
  format: z.enum(['source', 'markdown']),
}).strict().readonly()
const buddyArtifactQuoteSourceSchema = z.object({
  kind: z.literal('artifact'),
  title: z.string().trim().min(1).max(512),
  artifactId: buddyResourceIdSchema,
  conversationId: buddyResourceIdSchema,
  runId: buddyResourceIdSchema,
  path: z.string().min(1).max(32_768),
  updatedAt: timestampSchema,
  format: z.enum(['source', 'markdown']),
}).strict().readonly()
export const buddyFileQuoteSchema = z.object({ ...buddyTextQuoteFields, source: buddyFileQuoteSourceSchema }).strict().readonly()
export const buddyArtifactQuoteSchema = z.object({ ...buddyTextQuoteFields, source: buddyArtifactQuoteSourceSchema }).strict().readonly()
export const buddyTextQuoteSchema = z.object({ ...buddyTextQuoteFields, source: z.union([buddyFileQuoteSourceSchema, buddyArtifactQuoteSourceSchema]) }).strict().readonly()
export const buddyBrowserQuoteSchema = z.object({
  id: buddyResourceIdSchema,
  contentKind: z.literal('element'),
  text: z.string().min(1).max(BUDDY_QUOTE_TEXT_LIMIT).refine(text => text.trim().length > 0),
  source: browserSelectionSourceSchema,
  element: browserElementSnapshotSchema,
}).strict().readonly()
export const buddyViewQuoteSchema = z.object({
  id: buddyResourceIdSchema,
  text: z.string().min(1).max(BUDDY_QUOTE_TEXT_LIMIT).refine(text => text.trim().length > 0),
  source: referenceViewSourceSchema,
  locator: referenceLocatorSchema.optional(),
}).strict().readonly()
export type BuddyViewQuote = z.infer<typeof buddyViewQuoteSchema>
export const buddyResourceQuoteSchema = z.union([buddyTextQuoteSchema, buddyBrowserQuoteSchema, buddyViewQuoteSchema])
export function isBuddyViewQuote(quote: BuddyResourceQuote): quote is BuddyViewQuote {
  return quote.source.kind === 'view'
}
export type BuddyFileQuote = z.infer<typeof buddyFileQuoteSchema>
export type BuddyArtifactQuote = z.infer<typeof buddyArtifactQuoteSchema>
export type BuddyTextQuote = z.infer<typeof buddyTextQuoteSchema>
export type BuddyBrowserQuote = z.infer<typeof buddyBrowserQuoteSchema>
export type BuddyResourceQuote = z.infer<typeof buddyResourceQuoteSchema>
export const buddyResourceQuotesSchema = z.array(buddyResourceQuoteSchema)
  .max(BUDDY_QUOTE_COUNT_LIMIT)
  .refine(quotes => new Set(quotes.map(quote => quote.id)).size === quotes.length)
  .readonly()

const skillDirectiveSchema = z.object({
  directive: z.literal('skill'),
  type: z.literal('prompt_directive'),
  value: z.string().min(1),
  skill: skillReferenceSchema.optional(),
}).strict().readonly()

const slashDirectiveSchema = z.object({
  commandMode: z.enum(['prompt', 'action']),
  commandId: z.string().min(1).max(180).regex(/^[a-z][a-z0-9.-]+$/).optional(),
  directive: z.literal('slash_command'),
  type: z.literal('prompt_directive'),
  value: z.string().min(1),
}).strict().readonly()

export const buddyPromptDirectiveSchema = z.union([
  skillDirectiveSchema,
  slashDirectiveSchema,
])

export const buddyInlineNodeV1Schema = z.union([
  z.object({ text: z.string().min(1), type: z.literal('text') }).strict().readonly(),
  z.object({ type: z.literal('hard_break') }).strict().readonly(),
  z.object({ resourceId: buddyResourceIdSchema, type: z.literal('resource_ref') }).strict().readonly(),
  z.object({ sessionId: buddyResourceIdSchema, type: z.literal('session_ref') }).strict().readonly(),
  z.object({ quoteId: buddyResourceIdSchema, quoteKind: z.enum(['message', 'resource']), type: z.literal('quote_ref') }).strict().readonly(),
  buddyActorReferenceSchema,
  buddyPromptDirectiveSchema,
])

export const buddyUserContentV1Schema = z.object({
  body: z.array(z.object({
    content: z.array(buddyInlineNodeV1Schema).readonly(),
    type: z.literal('paragraph'),
  }).strict().readonly()).min(1).readonly(),
  panelResourceIds: z.array(buddyResourceIdSchema).refine(
    ids => new Set(ids).size === ids.length,
    'Duplicate panel resource',
  ).readonly(),
  quotes: buddyMessageQuotesSchema.optional(),
  resourceQuotes: buddyResourceQuotesSchema.optional(),
  sessionReferences: buddySessionReferencesSchema.optional(),
  version: z.literal(1),
}).strict().refine(content => content.body.every(paragraph => paragraph.content.every(node =>
  (node.type !== 'session_ref' || content.sessionReferences?.some(reference => reference.id === node.sessionId))
  && (node.type !== 'quote_ref' || (node.quoteKind === 'message' ? content.quotes : content.resourceQuotes)?.some(quote => quote.id === node.quoteId)),
)), 'Missing input material metadata').refine(content => (content.quotes?.length ?? 0) + (content.resourceQuotes?.length ?? 0) <= BUDDY_QUOTE_COUNT_LIMIT, 'Too many quotes').refine(content => [...content.quotes ?? [], ...content.resourceQuotes ?? []]
  .reduce((total, quote) => total + buddyQuoteSnapshotLength(quote), 0) <= BUDDY_QUOTE_TOTAL_TEXT_LIMIT, 'Quoted text exceeds total limit').readonly()

export type BuddyUserContentV1 = z.infer<typeof buddyUserContentV1Schema>
export type BuddyInlineNodeV1 = z.infer<typeof buddyInlineNodeV1Schema>
export type BuddyPromptDirective = z.infer<typeof buddyPromptDirectiveSchema>

export const buddyUserMessageResourceSnapshotSchema = z.object({
  attachmentId: buddyResourceIdSchema.optional(),
  localReference: buddyLocalResourceSchema.optional(),
  resourceId: buddyResourceIdSchema,
}).strict().refine(value => value.attachmentId !== undefined || value.localReference !== undefined).readonly()

export function getResourceAttachmentIds(resources: readonly BuddyUserMessageResourceSnapshot[]): string[] {
  return resources.flatMap(resource => resource.attachmentId ? [resource.attachmentId] : [])
}

export function bindResourceAttachments(resources: readonly BuddyUserMessageResourceSnapshot[], attachmentIds: readonly string[]): BuddyUserMessageResourceSnapshot[] {
  let index = 0
  const bound = resources.map(resource => resource.attachmentId
    ? { ...resource, attachmentId: attachmentIds[index++] }
    : resource)
  if (index !== attachmentIds.length || bound.some(resource => resource.attachmentId === undefined && !resource.localReference))
    throw new Error('Resource attachment bindings do not match')
  return bound
}

export const buddyUserMessageMaterialProjectionSchema = z.object({
  deferredReferences: z.boolean(),
  deferredResourceIds: z.array(buddyResourceIdSchema).max(16),
}).strict()

export const buddyUserMessageContentV1Schema = z.object({
  materialProjection: buddyUserMessageMaterialProjectionSchema.optional(),
  resourceSnapshots: z.array(buddyUserMessageResourceSnapshotSchema).readonly(),
  userContent: buddyUserContentV1Schema,
}).strict().superRefine((message, context) => {
  const contentResourceIds = getBuddyUserContentResourceIds(message.userContent)
  const snapshotResourceIds = message.resourceSnapshots.map(snapshot => snapshot.resourceId)
  const snapshotIdSet = new Set(snapshotResourceIds)

  if (snapshotIdSet.size !== snapshotResourceIds.length) {
    context.addIssue({
      code: 'custom',
      message: 'Duplicate message resource snapshot',
      path: ['resourceSnapshots'],
    })
  }
  for (const resourceId of contentResourceIds) {
    if (!snapshotIdSet.has(resourceId)) {
      context.addIssue({
        code: 'custom',
        message: 'Missing message resource snapshot',
        path: ['resourceSnapshots'],
      })
    }
  }
  const deferredIds = message.materialProjection?.deferredResourceIds ?? []
  if (new Set(deferredIds).size !== deferredIds.length || deferredIds.some(id => !message.resourceSnapshots.some(resource => resource.resourceId === id && resource.attachmentId))) {
    context.addIssue({ code: 'custom', message: 'Invalid deferred material binding', path: ['materialProjection'] })
  }
  const contentResourceIdSet = new Set(contentResourceIds)
  for (const resourceId of snapshotResourceIds) {
    if (!contentResourceIdSet.has(resourceId)) {
      context.addIssue({
        code: 'custom',
        message: 'Orphaned message resource snapshot',
        path: ['resourceSnapshots'],
      })
    }
  }
})

export type BuddyUserMessageContentV1 = z.infer<typeof buddyUserMessageContentV1Schema>
export type BuddyUserMessageResourceSnapshot = z.infer<typeof buddyUserMessageResourceSnapshotSchema>

export function readBuddyUserMessageContent(value: unknown): BuddyUserMessageContentV1 | null {
  const parsed = buddyUserMessageContentV1Schema.safeParse(value)
  return parsed.success ? parsed.data : null
}

export function createBuddyUserContent(text = ''): BuddyUserContentV1 {
  return {
    body: text.split('\n').map(line => ({
      content: line ? [{ text: line, type: 'text' }] : [],
      type: 'paragraph',
    })),
    panelResourceIds: [],
    version: 1,
  }
}

export function getBuddyUserContentResourceIds(content: BuddyUserContentV1): string[] {
  const inlineIds = content.body.flatMap(paragraph => paragraph.content.flatMap(
    node => node.type === 'resource_ref' ? [node.resourceId] : [],
  ))
  const inlineSet = new Set(inlineIds)
  return [...new Set([
    ...content.panelResourceIds.filter(id => !inlineSet.has(id)),
    ...inlineIds,
  ])]
}

export function getBuddyUserContentActorReferences(content: BuddyUserContentV1): BuddyActorReference[] {
  const references = new Map<string, BuddyActorReference>()
  for (const paragraph of content.body) {
    for (const node of paragraph.content) {
      if (node.type === 'actor_ref' && !references.has(node.actorId))
        references.set(node.actorId, node)
    }
  }
  return [...references.values()]
}

export function hasBuddyUserContent(content: BuddyUserContentV1 | null | undefined): boolean {
  if (!content)
    return false
  return Boolean(
    buddyUserContentToText(content).trim()
    || getBuddyUserContentResourceIds(content).length
    || content.quotes?.length
    || content.resourceQuotes?.length
    || content.sessionReferences?.length,
  )
}

export function buddyUserContentToText(
  content: BuddyUserContentV1,
  resourceLabel: (resourceId: string) => string = () => '@file',
): string {
  return content.body.map(paragraph => paragraph.content.map((node) => {
    switch (node.type) {
      case 'text': return node.text
      case 'hard_break': return '\n'
      case 'resource_ref': return resourceLabel(node.resourceId)
      case 'session_ref': return ''
      case 'quote_ref': return ''
      case 'actor_ref': return `@${node.name}`
      case 'prompt_directive': return buddyPromptDirectiveToText(node)
      default: throw new Error('Unsupported Composer inline node')
    }
  }).join('')).join('\n')
}

export function buddyPromptDirectiveToText(directive: BuddyPromptDirective): string {
  return directive.directive === 'skill' ? `$${directive.value}` : directive.value
}

function sameResourceQuote(a: BuddyResourceQuote, b: BuddyResourceQuote): boolean {
  if ('element' in a && 'element' in b) {
    return a.source.sessionId === b.source.sessionId && a.source.pageId === b.source.pageId
      && a.source.documentVersion === b.source.documentVersion && a.source.url === b.source.url
      && a.element.selector === b.element.selector && a.text === b.text
      && JSON.stringify(a.element) === JSON.stringify(b.element)
  }
  if ('element' in a || 'element' in b)
    return false
  if (isBuddyViewQuote(a) || isBuddyViewQuote(b)) {
    return isBuddyViewQuote(a) && isBuddyViewQuote(b) && a.source.provider === b.source.provider
      && sameReferenceJson(a.source.target, b.source.target)
      && sameReferenceJson(a.locator, b.locator) && a.text === b.text
  }
  const sameSource = a.source.kind === 'artifact' && b.source.kind === 'artifact'
    ? a.source.artifactId === b.source.artifactId && a.source.conversationId === b.source.conversationId
    && a.source.runId === b.source.runId && a.source.updatedAt === b.source.updatedAt && a.source.path === b.source.path
    : a.source.kind === 'file' && b.source.kind === 'file'
      && a.source.file.spaceId === b.source.file.spaceId && a.source.file.directoryId === b.source.file.directoryId
      && a.source.file.revision === b.source.file.revision && a.source.file.path === b.source.file.path
  return sameSource && a.source.format === b.source.format
    && a.text === b.text && a.textOffset === b.textOffset && JSON.stringify(a.range) === JSON.stringify(b.range)
}

export function appendBuddyResourceQuote(content: BuddyUserContentV1, quote: BuddyResourceQuote): { result: 'added' | 'duplicate' | 'limit', content: BuddyUserContentV1 } {
  const parsed = buddyResourceQuoteSchema.safeParse(quote)
  if (!parsed.success)
    return { result: 'limit', content }
  const quotes = content.resourceQuotes ?? []
  const candidate = parsed.data
  if (quotes.some(item => sameResourceQuote(item, candidate))) {
    return { result: 'duplicate', content }
  }
  const next: BuddyUserContentV1 = {
    ...content,
    body: content.body.map((paragraph, index) => index === content.body.length - 1
      ? { ...paragraph, content: [...paragraph.content, { type: 'quote_ref', quoteKind: 'resource', quoteId: candidate.id }] }
      : paragraph),
    resourceQuotes: [...quotes, candidate],
  }
  const validated = buddyUserContentV1Schema.safeParse(next)
  return validated.success ? { result: 'added', content: validated.data } : { result: 'limit', content }
}
