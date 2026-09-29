import type { DatabaseSync } from 'node:sqlite'
import type { ConversationBranchLineage } from './conversationHistoryRepository'
import { buddyUserContentToText, readBuddyUserMessageContent } from '../../../shared/conversation/buddyUserContent'

interface ContextMessage { id: string, role: 'user' | 'assistant', content_json: string, created_at: string }

export function createExtensionTaskContextRepository(database: DatabaseSync, lineage: ConversationBranchLineage) {
  const query = (conversationId: string, branchId: string, usersOnly: boolean, first: boolean, limit: number): ContextMessage[] => {
    const order = first ? 'ASC' : 'DESC'
    const messages = lineage.listVisibleSegments(conversationId, branchId).flatMap((segment) => {
      const through = segment.throughMessage
      return database.prepare(`SELECT id, role, content_json, created_at FROM messages
        WHERE conversation_id = ? AND branch_id = ? AND ${usersOnly ? 'role = \'user\'' : 'role IN (\'user\', \'assistant\')'}
        ${through ? 'AND (created_at < ? OR (created_at = ? AND id <= ?))' : ''}
        ORDER BY created_at ${order}, id ${order} LIMIT ?`).all(conversationId, segment.branchId, ...through ? [through.createdAt, through.createdAt, through.id] : [], limit) as unknown as ContextMessage[]
    })
    messages.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))
    return first ? messages.slice(0, limit) : messages.slice(-limit)
  }
  const activity = database.prepare(`SELECT CASE
    WHEN EXISTS (SELECT 1 FROM runs JOIN approvals ON approvals.run_id = runs.id WHERE runs.conversation_id = ? AND approvals.status = 'pending') THEN 'awaiting_approval'
    WHEN EXISTS (SELECT 1 FROM runs WHERE runs.conversation_id = ? AND runs.status IN ('queued', 'running')) THEN 'running'
    ELSE 'idle' END AS activity`)
  return {
    activity(conversationId: string): 'idle' | 'running' | 'awaiting_approval' {
      return (activity.get(conversationId, conversationId) as { activity: 'idle' | 'running' | 'awaiting_approval' }).activity
    },
    latestInput(conversationId: string, branchId: string) {
      return query(conversationId, branchId, true, false, 1)[0]?.id ?? null
    },
    messages(conversationId: string, branchId: string) {
      const first = query(conversationId, branchId, true, true, 1)
      const recent = query(conversationId, branchId, false, false, 15)
      return [...first, ...recent.filter(message => message.id !== first[0]?.id)].map((message) => {
        const content: unknown = JSON.parse(message.content_json)
        const structured = readBuddyUserMessageContent(content)
        const text = structured
          ? buddyUserContentToText(structured.userContent, () => '@file')
          : typeof content === 'string'
            ? content
            : content && typeof content === 'object' && 'text' in content && typeof content.text === 'string' ? content.text : ''
        return { role: message.role, text: text.slice(0, 1500) }
      }).filter(message => message.text.trim())
    },
  }
}
export type ExtensionTaskContextRepository = ReturnType<typeof createExtensionTaskContextRepository>
