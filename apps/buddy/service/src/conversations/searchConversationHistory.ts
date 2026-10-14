import type { ConversationRecord } from '../storage/conversationRecord'
import type { ConversationRepository } from '../storage/conversationRepository'
import { setImmediate } from 'node:timers/promises'
import { createSessionQuery, sessionMessageReferences, sessionMessageText } from './sessionReferenceText'

const MAX_RESULTS = 8
const MAX_SCANNED = 500
const PAGE_SIZE = 50
const EXCERPT_LENGTH = 1600

export async function searchConversationHistory(
  conversations: Pick<ConversationRepository, 'findById' | 'findMessageIdAtOffset' | 'listMessagePage'>,
  target: ConversationRecord,
  input: { query?: string, messageOffset?: number },
  signal?: AbortSignal,
) {
  const matchQuery = createSessionQuery(input.query)
  const matches: Array<{ source: { kind: 'message', messageId: string }, messageId: string, role: string, createdAt: string, excerpt: string, offset: number, sessionReferences: ReturnType<typeof sessionMessageReferences> }> = []
  const startOffset = input.messageOffset ?? 0
  let scanned = 0
  let boundary: string | undefined
  const result = (nextMessageOffset: number | null) => {
    signal?.throwIfAborted()
    return {
      sessionId: target.id,
      title: target.title,
      branchId: target.activeBranchId,
      matches,
      scanned,
      nextMessageOffset,
    }
  }
  while (true) {
    signal?.throwIfAborted()
    const current = conversations.findById(target.id)
    if (!current || current.deletedAt !== null || current.activeBranchId !== target.activeBranchId)
      throw new Error('SESSION_REFERENCE_UNAVAILABLE')
    if (boundary === undefined && startOffset > 0) {
      boundary = conversations.findMessageIdAtOffset(target.id, target.activeBranchId!, startOffset - 1) ?? undefined
      if (boundary === undefined)
        return result(null)
    }
    const page = conversations.listMessagePage(target.id, target.activeBranchId!, { beforeMessageId: boundary, limit: Math.min(PAGE_SIZE, MAX_SCANNED - scanned) })
    const items = page.items.toReversed()
    for (const [index, message] of items.entries()) {
      scanned += 1
      if (message.role !== 'user' && message.role !== 'assistant')
        continue
      const text = sessionMessageText(message.role, message.content)
      if (!text)
        continue
      const anchor = matchQuery(text)
      if (anchor < 0)
        continue
      const start = Math.max(0, anchor - 300)
      matches.push({
        source: { kind: 'message', messageId: message.id },
        offset: start,
        messageId: message.id,
        role: message.role,
        sessionReferences: sessionMessageReferences(message.role, message.content),
        createdAt: message.createdAt,
        excerpt: `${start ? '…' : ''}${text.slice(start, start + EXCERPT_LENGTH)}${text.length > start + EXCERPT_LENGTH ? '…' : ''}`,
      })
      if (matches.length === MAX_RESULTS)
        return result((index < items.length - 1 || page.nextBeforeMessageId) ? startOffset + scanned : null)
    }
    if (!page.nextBeforeMessageId)
      return result(null)
    if (scanned >= MAX_SCANNED)
      return result(startOffset + scanned)
    boundary = page.nextBeforeMessageId
    await setImmediate(undefined, { signal })
  }
}
