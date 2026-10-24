import { z } from 'zod'
import { MAX_BUDDY_MESSAGE_TEXT_LENGTH } from '../../../shared/conversation/buddyMessageContent'
import { projectBuddyQuoteText } from '../../../shared/conversation/buddyResourceQuoteText'
import { getBuddyUserContentResourceIds, readBuddyUserMessageContent } from '../../../shared/conversation/buddyUserContent'
import { projectBuddyUserText, sessionReferenceText } from '../../../shared/conversation/buddyUserReferenceText'

const source = {
  sourceId: z.string().min(1),
  sequence: z.number().int().positive(),
  branchId: z.string().min(1),
  runId: z.string().min(1).nullable(),
  sourceSequence: z.number().int().positive().nullable(),
  actorId: z.string().min(1).nullable(),
}

export const publicConversationMaterialSchema = z.discriminatedUnion('kind', [
  z.object({
    ...source,
    kind: z.literal('message'),
    messageId: z.string().min(1),
    role: z.enum(['user', 'assistant']),
    text: z.string().max(MAX_BUDDY_MESSAGE_TEXT_LENGTH),
    references: z.array(z.object({ kind: z.literal('resource'), resourceId: z.string().min(1) }).strict()).optional(),
  }).strict(),
  z.object({
    ...source,
    kind: z.literal('output'),
    artifacts: z.array(z.object({
      artifactId: z.string().min(1),
      name: z.string().min(1),
      kind: z.enum(['file', 'directory']),
    }).strict()).max(512),
  }).strict(),
])

export type PublicConversationMaterial = z.infer<typeof publicConversationMaterialSchema>

export function readPublicMessageText(content: unknown, role: 'user' | 'assistant', messageId?: string): string {
  if (typeof content === 'string')
    return content.slice(0, MAX_BUDDY_MESSAGE_TEXT_LENGTH)
  if (!content || typeof content !== 'object')
    return ''
  if (role === 'user') {
    const structured = readBuddyUserMessageContent(content)
    if (structured) {
      const text = [projectBuddyUserText(structured.userContent), sessionReferenceText(structured.userContent)].filter(Boolean).join('\n')
      return [text, projectBuddyQuoteText(structured.userContent, { sourceMessageId: messageId })].filter(Boolean).join('\n\n').slice(0, MAX_BUDDY_MESSAGE_TEXT_LENGTH)
    }
  }
  const text = (content as { text?: unknown }).text
  return typeof text === 'string' ? text.slice(0, MAX_BUDDY_MESSAGE_TEXT_LENGTH) : ''
}

export function readPublicMessageReferences(content: unknown): { kind: 'resource', resourceId: string }[] {
  const structured = readBuddyUserMessageContent(content)
  if (!structured)
    return []
  const references = new Set(getBuddyUserContentResourceIds(structured.userContent))
  return structured.resourceSnapshots.flatMap(snapshot => references.has(snapshot.resourceId) ? [{ kind: 'resource' as const, resourceId: snapshot.resourceId }] : [])
}
