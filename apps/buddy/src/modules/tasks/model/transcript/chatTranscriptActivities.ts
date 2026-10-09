import type { LocalMessage } from '@buddy-shared/conversation/conversationApi'
import type { ExtensionActionTimelineItem } from '@buddy-shared/extensions/extensionActionApi'
import type { ChatAgentToolNode, ChatAgentTurn } from './chatAgentTurn'
import type { ChatTranscriptActivityFlowRow, ChatTranscriptAgentTurnRow, ChatTranscriptCompactionRow, ChatTranscriptExtensionActionRow, ChatTranscriptMessageRow } from './chatTranscriptTypes'

export type PersistedChatTranscriptRow = ChatTranscriptAgentTurnRow | ChatTranscriptCompactionRow | ChatTranscriptExtensionActionRow | ChatTranscriptMessageRow
export type PresentedChatTranscriptRow = ChatTranscriptAgentTurnRow | ChatTranscriptCompactionRow | ChatTranscriptActivityFlowRow | ChatTranscriptMessageRow

export function projectChatTurnExtensionActions(
  turns: readonly ChatAgentTurn[],
  actions: readonly ExtensionActionTimelineItem[],
  messages: readonly LocalMessage[],
) {
  const inputs = new Map(messages.filter(message => message.role === 'user').map(message => [message.id, message]))
  const sortedTurns = [...turns].sort((left, right) => left.startedAt.localeCompare(right.startedAt) || left.runId.localeCompare(right.runId))
  const actionsByRun = new Map<string, ExtensionActionTimelineItem[]>()
  const independentActions: ExtensionActionTimelineItem[] = []
  for (const action of actions) {
    const source = action.sourceMessageId ? inputs.get(action.sourceMessageId) : undefined
    const branchTurns = sortedTurns.filter(turn => turn.branchId === action.branchId)
    const triggeredTurns = branchTurns.filter(turn => turn.triggeringMessageId === action.sourceMessageId)
    const candidates = triggeredTurns.length
      ? triggeredTurns
      : branchTurns.filter(turn => source
        && source.branchId === turn.branchId
        && source.createdAt >= turn.startedAt
        && (turn.completedAt === null || source.createdAt <= turn.completedAt))
    const owner = candidates.findLast(turn => turn.startedAt <= action.createdAt) ?? candidates[0]
    if (!owner) {
      independentActions.push(action)
      continue
    }
    const members = actionsByRun.get(owner.runId) ?? []
    members.push(action)
    actionsByRun.set(owner.runId, members)
  }
  return {
    independentActions,
    turns: sortedTurns.map((turn) => {
      const members = actionsByRun.get(turn.runId)
      if (!members)
        return turn
      const nodeStartedAt = { ...turn.nodeStartedAt, ...Object.fromEntries(members.map(action => [`extension-action:${action.id}`, action.createdAt])) }
      const nodes = [...turn.nodes]
      for (const action of [...members].sort((left, right) => left.createdAt.localeCompare(right.createdAt))) {
        const index = nodes.findIndex(node => (nodeStartedAt[node.id] ?? turn.startedAt) > action.createdAt)
        nodes.splice(index === -1 ? nodes.length : index, 0, projectExtensionActionTool(action))
      }
      return { ...turn, nodes, nodeStartedAt }
    }),
  }
}

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
      if (previous?.kind === 'activity-flow' && previous.nodes.every(member => member.invocation?.branchId === row.action.branchId
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
    }
    presented.push(row)
  }
  return presented
}
