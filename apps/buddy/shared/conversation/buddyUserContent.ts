import { z } from 'zod'
import { skillReferenceSchema } from '../skills/skillApi'
import { buddyLocalResourceSchema } from './localResource'

export const buddyResourceIdSchema = z.string().regex(/^[A-Z0-9][\w-]{0,127}$/i)

export const BUDDY_QUOTE_COUNT_LIMIT = 16
export const BUDDY_QUOTE_TEXT_LIMIT = 32_768

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

const skillDirectiveSchema = z.object({
  directive: z.literal('skill'),
  type: z.literal('prompt_directive'),
  value: z.string().min(1),
  skill: skillReferenceSchema.optional(),
}).strict().readonly()

const slashDirectiveSchema = z.object({
  commandMode: z.enum(['prompt', 'action']),
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
  version: z.literal(1),
}).strict().readonly()

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

export const buddyUserMessageContentV1Schema = z.object({
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

export function hasBuddyUserContent(content: BuddyUserContentV1 | null | undefined): boolean {
  if (!content)
    return false
  return Boolean(
    buddyUserContentToText(content).trim()
    || getBuddyUserContentResourceIds(content).length
    || content.quotes?.length,
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
      case 'prompt_directive': return buddyPromptDirectiveToText(node)
      default: throw new Error('Unsupported Composer inline node')
    }
  }).join('')).join('\n')
}

export function buddyPromptDirectiveToText(directive: BuddyPromptDirective): string {
  return directive.directive === 'skill' ? `$${directive.value}` : directive.value
}
