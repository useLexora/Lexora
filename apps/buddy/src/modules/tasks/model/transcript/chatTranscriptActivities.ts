import type { ExtensionActionTimelineItem } from '@buddy-shared/extensions/extensionActionApi'
import type { ChatAgentToolNode, ChatAgentTurn } from './chatAgentTurn'
import type { ChatTranscriptActivityFlowRow, ChatTranscriptAgentTurnRow, ChatTranscriptCompactionRow, ChatTranscriptExtensionActionRow, ChatTranscriptMessageRow } from './chatTranscriptTypes'

export type PersistedChatTranscriptRow = ChatTranscriptAgentTurnRow | ChatTranscriptCompactionRow | ChatTranscriptExtensionActionRow | ChatTranscriptMessageRow
export type PresentedChatTranscriptRow = ChatTranscriptAgentTurnRow | ChatTranscriptCompactionRow | ChatTranscriptActivityFlowRow | ChatTranscriptMessageRow

export function projectExtensionActionTool(invocation: Readonly<ExtensionActionTimelineItem>): ChatAgentToolNode {
  return {
    id: `extension-action:${invocation.id}`,
    kind: 'tool',
    invocation,
    toolName: invocation.actionId,
    toolLabel: invocation.title,
    description: null,
    status: invocation.status,
    isError: invocation.status === 'failed' || invocation.status === 'interrupted',
    progressPlacement: 'inline',
    presentation: { card: 'generic', argumentNames: [], description: null, output: invocation.message, truncated: false },
  }
}

export function mergeChatTranscriptActivities(rows: readonly PersistedChatTranscriptRow[]): PresentedChatTranscriptRow[] {
  const presented: PresentedChatTranscriptRow[] = []
  for (const row of rows) {
    const previous = presented.at(-1)
    if (row.kind === 'extension-action') {
      const node = projectExtensionActionTool(row.action)
      if (previous?.kind === 'agent-turn' && belongsToTurn(row.action, previous.turn)) {
        presented[presented.length - 1] = { ...previous, turn: { ...previous.turn, nodes: [...previous.turn.nodes, node] } }
      }
      else if (previous?.kind === 'activity-flow' && previous.nodes.every(member => member.invocation?.branchId === row.action.branchId
        && member.invocation.sourceMessageId === row.action.sourceMessageId)) {
        presented[presented.length - 1] = { ...previous, nodes: [...previous.nodes, node] }
      }
      else {
        presented.push({ kind: 'activity-flow', key: row.key, createdAt: row.action.createdAt, nodes: [node] })
      }
      continue
    }
    if (row.kind === 'agent-turn') {
      if (previous?.kind === 'agent-turn' && previous.turn.runId === row.turn.runId) {
        presented[presented.length - 1] = { ...row, key: previous.key, turn: { ...row.turn, nodes: [...previous.turn.nodes, ...row.turn.nodes] } }
        continue
      }
      if (previous?.kind === 'activity-flow' && previous.nodes.every(node => node.invocation && belongsToTurn(node.invocation, row.turn))) {
        presented[presented.length - 1] = { ...row, turn: { ...row.turn, nodes: [...previous.nodes, ...row.turn.nodes] } }
        continue
      }
    }
    presented.push(row)
  }
  return presented
}

function belongsToTurn(action: Readonly<ExtensionActionTimelineItem>, turn: ChatAgentTurn): boolean {
  return action.sourceMessageId === turn.triggeringMessageId
    && action.branchId === turn.branchId
    && (!turn.completedAt || action.createdAt <= turn.completedAt)
}
