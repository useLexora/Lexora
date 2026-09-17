import type { ChatAgentCompactionNode, ChatAgentNarrationNode, ChatAgentPanelNode, ChatAgentReasoningNode, ChatAgentToolNode, ChatAgentTurnNode } from './chatAgentTurn'
import type { ChatToolCategory, ChatToolIcon } from './chatToolRegistry'
import { isChatToolIssue } from './chatToolDisplay'
import { getChatToolRegistration } from './chatToolRegistry'

export interface ChatAgentActivityGroup {
  id: string
  kind: 'activity-group'
  nodes: ReadonlyArray<ChatAgentReasoningNode | ChatAgentToolNode>
  issueCount: number
  toolCount: number
  icon: ChatToolIcon | 'reasoning'
  counts: ReadonlyArray<{ category: ChatToolCategory, count: number, files: number | null }>
}

export type ChatAgentActivityRow = ChatAgentActivityGroup | ChatAgentNarrationNode | ChatAgentCompactionNode | ChatAgentPanelNode

export function createChatAgentActivityProjector() {
  let source: ReadonlyArray<ChatAgentTurnNode> | null = null
  let rows: ReadonlyArray<ChatAgentActivityRow> = []

  return {
    project(nodes: ReadonlyArray<ChatAgentTurnNode>): ReadonlyArray<ChatAgentActivityRow> {
      if (source === nodes)
        return rows
      const previous = new Map(rows.map(row => [row.id, row]))
      const next: ChatAgentActivityRow[] = []
      let boundary = 'start'
      let members: Array<ChatAgentReasoningNode | ChatAgentToolNode> = []
      function flush() {
        if (!members.length)
          return
        const id = `activity:${boundary}`
        const cached = previous.get(id)
        next.push(cached?.kind === 'activity-group'
          && cached.nodes.length === members.length
          && cached.nodes.every((node, index) => node === members[index])
          ? cached
          : summarizeGroup(id, members))
        members = []
      }
      for (const node of nodes) {
        if (node.kind === 'reasoning' || node.kind === 'tool') {
          members.push(node)
          continue
        }
        flush()
        next.push(node)
        boundary = node.id
      }
      flush()
      source = nodes
      rows = next
      return rows
    },
  }
}

function summarizeGroup(id: string, nodes: ChatAgentActivityGroup['nodes']): ChatAgentActivityGroup {
  const counts = new Map<ChatToolCategory, number>()
  const files = new Map<ChatToolCategory, Set<string> | null>()
  let issueCount = 0
  let toolCount = 0
  let icon: ChatAgentActivityGroup['icon'] = 'reasoning'
  for (const node of nodes) {
    if (node.kind === 'reasoning')
      continue
    toolCount++
    const { category, icon: toolIcon } = getChatToolRegistration(node)
    icon = icon === 'reasoning' || icon === toolIcon ? toolIcon : 'activity'
    counts.set(category, (counts.get(category) ?? 0) + 1)
    if (category === 'read' || category === 'create' || category === 'edit') {
      const p = node.presentation
      const path = p.card === 'read' || p.card === 'diff' ? p.path : ''
      if (!path) {
        files.set(category, null)
      }
      else if (files.get(category) !== null) {
        const paths = files.get(category) ?? new Set<string>()
        paths.add(path.replaceAll('\\', '/'))
        files.set(category, paths)
      }
    }
    if (isChatToolIssue(node))
      issueCount++
  }
  return { id, kind: 'activity-group', nodes, issueCount, toolCount, icon, counts: [...counts].map(([category, count]) => ({ category, count, files: files.get(category)?.size ?? null })) }
}
