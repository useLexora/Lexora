import type { DatabaseSync } from 'node:sqlite'
import { withTransaction } from './database'

export type MessageRole = 'user' | 'assistant' | 'tool'

export interface ConversationBranchRecord {
  id: string
  conversationId: string
  parentBranchId: string | null
  forkedFromMessageId: string | null
  createdAt: string
}

export interface MessageRecord {
  id: string
  conversationId: string
  branchId: string
  runId: string | null
  role: MessageRole
  content: unknown
  createdAt: string
}

export interface MessagePageRecord {
  items: MessageRecord[]
  nextBeforeMessageId: string | null
}

export interface ListMessagePageOptions {
  beforeMessageId?: string | null
  limit: number
}

export interface CreateBranchInput {
  id: string
  conversationId: string
  parentBranchId: string | null
  forkedFromMessageId: string | null
  createdAt: string
  activate: boolean
}

export interface CreateMessageInput {
  id: string
  conversationId: string
  branchId: string
  runId: string | null
  role: MessageRole
  content: unknown
  createdAt: string
}

export interface ActivateConversationBranchInput {
  branchId: string
  conversationId: string
  updatedAt: string
}

export interface ConversationHistoryRepository {
  createBranch: (input: CreateBranchInput) => ConversationBranchRecord
  createMessage: (input: CreateMessageInput) => MessageRecord
  findMessageById: (id: string) => MessageRecord | null
  listBranchMessages: (conversationId: string, branchId: string) => MessageRecord[]
  listBranches: (conversationId: string) => ConversationBranchRecord[]
  listMessagePage: (
    conversationId: string,
    branchId: string,
    options: ListMessagePageOptions,
  ) => MessagePageRecord
  listMessages: (conversationId: string, branchId: string, limit?: number) => MessageRecord[]
}

export interface VisibleConversationBranchSegment {
  branchId: string
  throughMessage: {
    createdAt: string
    id: string
  } | null
}

export interface ConversationBranchLineage {
  listVisibleSegments: (
    conversationId: string,
    branchId: string,
  ) => VisibleConversationBranchSegment[]
}

export interface ConversationHistoryStore {
  activateBranch: (input: ActivateConversationBranchInput) => void
  insertRootBranch: (input: {
    branchId: string
    conversationId: string
    createdAt: string
  }) => void
  lineage: ConversationBranchLineage
  repository: ConversationHistoryRepository
}

interface ConversationStateRow {
  active_branch_id: string | null
  deleted_at: string | null
}

interface BranchRow {
  id: string
  conversation_id: string
  parent_branch_id: string | null
  forked_from_message_id: string | null
  created_at: string
}

interface MessageRow {
  id: string
  conversation_id: string
  branch_id: string
  run_id: string | null
  role: MessageRole
  content_json: string
  created_at: string
}

export function createConversationHistoryStore(database: DatabaseSync): ConversationHistoryStore {
  const findConversation = database.prepare(`
    SELECT active_branch_id, deleted_at FROM conversations WHERE id = ?
  `)
  const findBranch = database.prepare('SELECT * FROM conversation_branches WHERE id = ?')
  const publicMessage = `(run_id IS NULL OR EXISTS (SELECT 1 FROM conversation_publications WHERE message_id = messages.id) OR EXISTS (SELECT 1 FROM runs WHERE runs.id = messages.run_id AND (runs.execution_kind = 'root' OR (runs.execution_kind = 'actor_child' AND messages.role = 'assistant'))))`
  const findMessage = database.prepare(`SELECT * FROM messages WHERE id = ? AND ${publicMessage}`)
  const insertBranch = database.prepare(`
    INSERT INTO conversation_branches (
      id, conversation_id, parent_branch_id, forked_from_message_id, created_at
    ) VALUES (?, ?, ?, ?, ?)
  `)
  const activateBranch = database.prepare(`
    UPDATE conversations SET active_branch_id = ?, updated_at = ? WHERE id = ?
  `)
  const insertMessage = database.prepare(`
    INSERT INTO messages (
      id, conversation_id, branch_id, run_id, role, content_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `)
  const listAllMessagesForBranch = database.prepare(`
    SELECT * FROM messages
    WHERE conversation_id = ? AND branch_id = ? AND ${publicMessage}
    ORDER BY created_at, id
  `)
  const listNewestMessagesForBranch = database.prepare(`
    SELECT * FROM messages
    WHERE conversation_id = ? AND branch_id = ? AND ${publicMessage}
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `)
  const listMessagesForBranchBefore = database.prepare(`
    SELECT * FROM messages
    WHERE conversation_id = ? AND branch_id = ? AND ${publicMessage}
      AND (created_at < ? OR (created_at = ? AND id < ?))
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `)
  const listMessagesForBranchThrough = database.prepare(`
    SELECT * FROM messages
    WHERE conversation_id = ? AND branch_id = ? AND ${publicMessage}
      AND (created_at < ? OR (created_at = ? AND id <= ?))
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `)
  const listBranches = database.prepare(`
    SELECT * FROM conversation_branches
    WHERE conversation_id = ?
    ORDER BY created_at, id
  `)
  const findIncompleteRun = database.prepare(`
    SELECT 1 FROM runs
    WHERE conversation_id = ? AND execution_kind IN ('root', 'maintenance') AND status IN ('queued', 'running')
    LIMIT 1
  `)
  const collectBranchMessages = (
    conversationId: string,
    branchId: string,
    visited = new Set<string>(),
  ): MessageRecord[] => {
    if (visited.has(branchId))
      throw new Error('Lexora Buddy conversation branch ancestry is invalid')
    visited.add(branchId)
    const branch = findBranch.get(branchId) as BranchRow | undefined
    if (!branch || branch.conversation_id !== conversationId)
      throw new Error('Lexora Buddy conversation branch was not found')

    let ancestors: MessageRecord[] = []
    if (branch.parent_branch_id) {
      ancestors = collectBranchMessages(conversationId, branch.parent_branch_id, visited)
      const forkIndex = ancestors.findIndex(message => message.id === branch.forked_from_message_id)
      if (forkIndex < 0)
        throw new Error('Lexora Buddy conversation fork point was not found')
      ancestors = ancestors.slice(0, forkIndex + 1)
    }
    const current = (listAllMessagesForBranch.all(
      conversationId,
      branchId,
    ) as unknown as MessageRow[]).map(toMessage)
    return [...ancestors, ...current]
  }
  const collectVisibleBranchSegments = (
    conversationId: string,
    branchId: string,
    visited = new Set<string>(),
  ): VisibleConversationBranchSegment[] => {
    if (visited.has(branchId))
      throw new Error('Lexora Buddy conversation branch ancestry is invalid')
    visited.add(branchId)
    const branch = findBranch.get(branchId) as BranchRow | undefined
    if (!branch || branch.conversation_id !== conversationId)
      throw new Error('Lexora Buddy conversation branch was not found')
    if (!branch.parent_branch_id)
      return [{ branchId, throughMessage: null }]

    const segments = collectVisibleBranchSegments(
      conversationId,
      branch.parent_branch_id,
      visited,
    )
    const forkMessage = findMessage.get(branch.forked_from_message_id) as MessageRow | undefined
    const segmentIndex = forkMessage
      ? segments.findIndex(segment => segment.branchId === forkMessage.branch_id)
      : -1
    const segment = segmentIndex >= 0 ? segments[segmentIndex] : null
    if (
      !forkMessage
      || forkMessage.conversation_id !== conversationId
      || !segment
      || (segment.throughMessage && compareMessageOrder(
        toMessageOrder(forkMessage),
        segment.throughMessage,
      ) > 0)
    ) {
      throw new Error('Lexora Buddy conversation fork point was not found')
    }
    return [
      ...segments.slice(0, segmentIndex),
      { branchId: segment.branchId, throughMessage: toMessageOrder(forkMessage) },
      { branchId, throughMessage: null },
    ]
  }

  return {
    activateBranch(input) {
      const conversation = findConversation.get(input.conversationId) as
        | ConversationStateRow
        | undefined
      const branch = findBranch.get(input.branchId) as BranchRow | undefined
      if (
        !conversation
        || conversation.deleted_at !== null
        || !branch
        || branch.conversation_id !== input.conversationId
      ) {
        throw new ConversationHistoryError('branch is not activatable')
      }
      if (conversation.active_branch_id === input.branchId)
        return
      if (findIncompleteRun.get(input.conversationId))
        throw new ConversationHistoryError('branch is not activatable')
      activateBranch.run(input.branchId, input.updatedAt, input.conversationId)
    },
    insertRootBranch(input) {
      insertBranch.run(input.branchId, input.conversationId, null, null, input.createdAt)
      activateBranch.run(input.branchId, input.createdAt, input.conversationId)
    },
    lineage: {
      listVisibleSegments: collectVisibleBranchSegments,
    },
    repository: {
      createBranch(input) {
        return withTransaction(database, () => {
          if ((input.parentBranchId === null) !== (input.forkedFromMessageId === null))
            throw new Error('Lexora Buddy conversation fork binding is invalid')
          if (input.parentBranchId && input.forkedFromMessageId) {
            const parent = findBranch.get(input.parentBranchId) as BranchRow | undefined
            if (
              !parent
              || parent.conversation_id !== input.conversationId
              || !collectBranchMessages(input.conversationId, input.parentBranchId)
                .some(message => message.id === input.forkedFromMessageId)
            ) {
              throw new Error('Lexora Buddy conversation fork binding is invalid')
            }
          }
          insertBranch.run(
            input.id,
            input.conversationId,
            input.parentBranchId,
            input.forkedFromMessageId,
            input.createdAt,
          )
          if (input.activate)
            activateBranch.run(input.id, input.createdAt, input.conversationId)
          return toBranch(requireRow<BranchRow>(findBranch.get(input.id), input.id))
        })
      },
      createMessage(input) {
        return withTransaction(database, () => {
          insertMessage.run(input.id, input.conversationId, input.branchId, input.runId, input.role, JSON.stringify(input.content), input.createdAt)
          return toMessage(requireRow<MessageRow>(findMessage.get(input.id), input.id))
        })
      },
      findMessageById(id) {
        const row = findMessage.get(id) as MessageRow | undefined
        return row ? toMessage(row) : null
      },
      listBranchMessages(conversationId, branchId) {
        return collectBranchMessages(conversationId, branchId)
      },
      listBranches(conversationId) {
        return (listBranches.all(conversationId) as unknown as BranchRow[]).map(toBranch)
      },
      listMessagePage(conversationId, branchId, options) {
        if (options.limit <= 0)
          return { items: [], nextBeforeMessageId: null }
        const segments = collectVisibleBranchSegments(conversationId, branchId)
        const boundary = options.beforeMessageId
          ? findMessage.get(options.beforeMessageId) as MessageRow | undefined
          : null
        let segmentIndex = segments.length - 1
        if (options.beforeMessageId) {
          segmentIndex = boundary
            ? segments.findIndex(segment => segment.branchId === boundary.branch_id)
            : -1
          const segment = segmentIndex >= 0 ? segments[segmentIndex] : null
          if (
            !boundary
            || boundary.conversation_id !== conversationId
            || !segment
            || (segment.throughMessage && compareMessageOrder(
              toMessageOrder(boundary),
              segment.throughMessage,
            ) > 0)
          ) {
            throw new ConversationHistoryError('message cursor is invalid')
          }
        }
        const descending: MessageRow[] = []
        for (
          let index = segmentIndex;
          index >= 0 && descending.length <= options.limit;
          index -= 1
        ) {
          const segment = segments[index]!
          const remaining = options.limit + 1 - descending.length
          const rows = boundary && index === segmentIndex
            ? listMessagesForBranchBefore.all(
              conversationId,
              segment.branchId,
              boundary.created_at,
              boundary.created_at,
              boundary.id,
              remaining,
            ) as unknown as MessageRow[]
            : segment.throughMessage
              ? listMessagesForBranchThrough.all(
                conversationId,
                segment.branchId,
                segment.throughMessage.createdAt,
                segment.throughMessage.createdAt,
                segment.throughMessage.id,
                remaining,
              ) as unknown as MessageRow[]
              : listNewestMessagesForBranch.all(
                conversationId,
                segment.branchId,
                remaining,
              ) as unknown as MessageRow[]
          descending.push(...rows)
        }
        const hasMore = descending.length > options.limit
        const items = descending
          .slice(0, options.limit)
          .reverse()
          .map(toMessage)
        return {
          items,
          nextBeforeMessageId: hasMore ? items[0]?.id ?? null : null,
        }
      },
      listMessages(conversationId, branchId, limit = 500) {
        if (limit <= 0)
          return []
        return collectBranchMessages(conversationId, branchId).slice(-limit)
      },
    },
  }
}

class ConversationHistoryError extends Error {
  readonly code = 'VALIDATION_FAILED'

  constructor(reason: string) {
    super(`Lexora Buddy conversation ${reason}`)
    this.name = 'ConversationHistoryError'
  }
}

function requireRow<T>(value: unknown, id: string): T {
  if (!value)
    throw new Error(`Lexora Buddy storage row was not persisted: ${id}`)
  return value as T
}

function toBranch(row: BranchRow): ConversationBranchRecord {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    parentBranchId: row.parent_branch_id,
    forkedFromMessageId: row.forked_from_message_id,
    createdAt: row.created_at,
  }
}

function toMessage(row: MessageRow): MessageRecord {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    branchId: row.branch_id,
    runId: row.run_id,
    role: row.role,
    content: JSON.parse(row.content_json),
    createdAt: row.created_at,
  }
}

function compareMessageOrder(
  left: NonNullable<VisibleConversationBranchSegment['throughMessage']>,
  right: NonNullable<VisibleConversationBranchSegment['throughMessage']>,
): number {
  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)
}

function toMessageOrder(
  message: MessageRow,
): NonNullable<VisibleConversationBranchSegment['throughMessage']> {
  return {
    createdAt: message.created_at,
    id: message.id,
  }
}
