import type { ConversationTimelineBoundaryRecord } from '../storage/conversationTimelineRepository'
import { Buffer } from 'node:buffer'

import { z } from 'zod'

interface ConversationTimelineCursorScope {
  branchId: string
  conversationId: string
}

interface CreateConversationTimelineCursorInput extends ConversationTimelineCursorScope {
  before: ConversationTimelineBoundaryRecord
}

const timelineBoundarySchema = z.object({
  branchId: z.string().trim().min(1).max(256),
  id: z.string().trim().min(1).max(256),
  kind: z.enum(['message', 'compaction', 'extension-action']),
  occurredAt: z.iso.datetime(),
}).strict()

const cursorPayloadSchema = z.object({
  before: timelineBoundarySchema,
  branchId: z.string().trim().min(1).max(256),
  conversationId: z.string().trim().min(1).max(256),
  version: z.literal(1),
}).strict()

export function createConversationTimelineCursor(
  input: CreateConversationTimelineCursorInput,
): string {
  return Buffer.from(JSON.stringify({
    ...input,
    version: 1,
  })).toString('base64url')
}

export function parseConversationTimelineCursor(
  cursor: string,
  scope: ConversationTimelineCursorScope,
): ConversationTimelineBoundaryRecord {
  try {
    const payload = cursorPayloadSchema.parse(JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8'),
    ))
    if (
      payload.branchId !== scope.branchId
      || payload.conversationId !== scope.conversationId
    ) {
      throw new ConversationTimelineCursorError()
    }
    return payload.before
  }
  catch (error) {
    if (error instanceof ConversationTimelineCursorError)
      throw error
    throw new ConversationTimelineCursorError()
  }
}

export class ConversationTimelineCursorError extends Error {
  readonly code = 'VALIDATION_FAILED'

  constructor() {
    super('Lexora Buddy conversation timeline cursor is invalid')
    this.name = 'ConversationTimelineCursorError'
  }
}
