import type { LocalConversationBranch, LocalMessage } from '@buddy-shared/conversation/conversationApi'

import type { ChatAgentTurn } from './chatAgentTurn'
import type {
  ChatTranscriptProjection,
  ChatTranscriptRow,
  ChatTranscriptRowPatch,
} from './chatTranscriptProjection'

export interface ChatMessageBranchNavigator {
  activeBranchId: string
  count: number
  index: number
  nextBranchId: string | null
  previousBranchId: string | null
}

interface BranchGroup {
  baseBranchId: string | null
  branchIds: string[]
  forkedFromMessageId: string | null
}

interface CachedChatMessageBranchNavigators {
  activeBranchId: string
  branches: ReadonlyArray<LocalConversationBranch>
  navigators: ReadonlyMap<string, ChatMessageBranchNavigator>
  rows: ReadonlyArray<ChatTranscriptRow>
}

export function createChatMessageBranchNavigatorProjector() {
  let cached: CachedChatMessageBranchNavigators | null = null

  return {
    project(
      projection: ChatTranscriptProjection,
      branches: ReadonlyArray<LocalConversationBranch>,
      activeBranchId: string,
    ): ReadonlyMap<string, ChatMessageBranchNavigator> {
      const previous = cached
      if (
        previous
        && previous.branches === branches
        && previous.activeBranchId === activeBranchId
        && (
          previous.rows === projection.rows
          || (
            projection.update.kind === 'patch'
            && projection.update.previousRows === previous.rows
            && projection.update.patches.every(patch => preservesBranchNavigation(previous.rows, patch))
          )
        )
      ) {
        cached = { ...previous, rows: projection.rows }
        return cached.navigators
      }

      const navigators = projectChatMessageBranchNavigators(
        projection.rows,
        branches,
        activeBranchId,
      )
      cached = {
        activeBranchId,
        branches,
        navigators,
        rows: projection.rows,
      }
      return navigators
    },
  }
}

export function projectChatMessageBranchNavigators(
  rows: ReadonlyArray<ChatTranscriptRow>,
  branches: ReadonlyArray<LocalConversationBranch>,
  activeBranchId: string,
): ReadonlyMap<string, ChatMessageBranchNavigator> {
  const branchById = new Map(branches.map(branch => [branch.id, branch]))
  const activePath = collectActiveBranchPath(activeBranchId, branchById)
  if (!activePath.length)
    return new Map()

  const messages = rows.flatMap(row => row.kind === 'message' ? [row.message] : [])
  const actionMessageIds = new Set(rows.flatMap(row => row.kind === 'message'
    && (row.message.role === 'user' || row.ownsResultActions || (row.message.role === 'assistant' && !row.message.runId))
    ? [row.message.id]
    : []))
  const actionTurns = rows.flatMap((row) => {
    if (row.kind === 'message')
      return row.turnResult ? [row.turnResult] : []
    if (row.kind === 'turn-result' || (row.kind === 'agent-turn' && row.ownsResultActions))
      return [row.turn]
    return []
  })
  const activePathIds = new Set(activePath.map(branch => branch.id))
  const navigators = new Map<string, ChatMessageBranchNavigator>()

  for (const group of collectBranchGroups(branches, messages)) {
    if (group.branchIds.length < 2)
      continue
    const activeGroupBranchId = resolveActiveGroupBranchId(group, activePath, activePathIds)
    if (!activeGroupBranchId)
      continue
    const targetId = resolveNavigatorTargetId(group, activeGroupBranchId, messages, actionTurns, actionMessageIds)
    if (!targetId)
      continue
    const index = group.branchIds.indexOf(activeGroupBranchId)
    if (index < 0)
      continue
    navigators.set(targetId, {
      activeBranchId: activeGroupBranchId,
      count: group.branchIds.length,
      index: index + 1,
      nextBranchId: group.branchIds[index + 1] ?? null,
      previousBranchId: group.branchIds[index - 1] ?? null,
    })
  }

  return navigators
}

function preservesBranchNavigation(
  rows: ReadonlyArray<ChatTranscriptRow>,
  patch: ChatTranscriptRowPatch,
): boolean {
  if (patch.deleteCount !== 1 || patch.rows.length !== 1)
    return false
  const previous = rows[patch.index]
  const next = patch.rows[0]
  if (!previous || !next || previous.kind !== next.kind || previous.key !== next.key)
    return false
  if (previous.kind === 'message' && next.kind === 'message') {
    return previous.message.id === next.message.id
      && previous.message.branchId === next.message.branchId
      && previous.message.role === next.message.role
      && previous.message.runId === next.message.runId
      && previous.resultRunId === next.resultRunId
      && previous.ownsResultActions === next.ownsResultActions
      && previous.turnResult?.runId === next.turnResult?.runId
      && previous.turnResult?.branchId === next.turnResult?.branchId
      && previous.turnResult?.triggeringMessageId === next.turnResult?.triggeringMessageId
  }
  if (previous.kind === 'agent-turn' && next.kind === 'agent-turn') {
    if (previous.ownsResultActions !== next.ownsResultActions)
      return false
    if (!previous.ownsResultActions)
      return true
    return previous.turn.runId === next.turn.runId
      && previous.turn.branchId === next.turn.branchId
      && previous.turn.status === next.turn.status
      && previous.turn.triggeringMessageId === next.turn.triggeringMessageId
  }
  return true
}

function collectActiveBranchPath(
  activeBranchId: string,
  branchById: ReadonlyMap<string, LocalConversationBranch>,
): LocalConversationBranch[] {
  const path: LocalConversationBranch[] = []
  const visited = new Set<string>()
  let branch = branchById.get(activeBranchId)
  while (branch && !visited.has(branch.id)) {
    visited.add(branch.id)
    path.unshift(branch)
    branch = branch.parentBranchId ? branchById.get(branch.parentBranchId) : undefined
  }
  return path
}

function collectBranchGroups(
  branches: ReadonlyArray<LocalConversationBranch>,
  messages: ReadonlyArray<LocalMessage>,
): BranchGroup[] {
  const ordered = [...branches].sort((left, right) =>
    left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
  )
  const rootBranches = ordered.filter(branch =>
    branch.parentBranchId === null && branch.forkedFromMessageId === null,
  )
  const groups = new Map<string, BranchGroup>()
  if (rootBranches.length) {
    groups.set('root', {
      baseBranchId: null,
      branchIds: rootBranches.map(branch => branch.id),
      forkedFromMessageId: null,
    })
  }

  const messageBranchById = new Map(messages.map(message => [message.id, message.branchId]))
  for (const branch of ordered) {
    if (!branch.parentBranchId || !branch.forkedFromMessageId)
      continue
    const key = branch.forkedFromMessageId
    const group = groups.get(key) ?? {
      baseBranchId: messageBranchById.get(branch.forkedFromMessageId)
        ?? branch.parentBranchId,
      branchIds: [messageBranchById.get(branch.forkedFromMessageId)
        ?? branch.parentBranchId],
      forkedFromMessageId: branch.forkedFromMessageId,
    }
    if (!group.branchIds.includes(branch.id))
      group.branchIds.push(branch.id)
    groups.set(key, group)
  }
  return [...groups.values()]
}

function resolveActiveGroupBranchId(
  group: BranchGroup,
  activePath: ReadonlyArray<LocalConversationBranch>,
  activePathIds: ReadonlySet<string>,
): string | null {
  if (![...group.branchIds].some(branchId => activePathIds.has(branchId)))
    return null
  return activePath.findLast(branch => group.branchIds.includes(branch.id))?.id ?? null
}

function resolveNavigatorTargetId(
  group: BranchGroup,
  activeGroupBranchId: string,
  messages: ReadonlyArray<LocalMessage>,
  actionTurns: ReadonlyArray<ChatAgentTurn>,
  actionMessageIds: ReadonlySet<string>,
): string | null {
  if (group.baseBranchId === null)
    return messages.find(message => message.branchId === activeGroupBranchId && actionMessageIds.has(message.id))?.id ?? null
  const forkMessage = messages.find(message => message.id === group.forkedFromMessageId)
  const terminalTurnTarget = forkMessage?.role === 'user'
    ? resolveTerminalTurnTarget(activeGroupBranchId, forkMessage.id, actionTurns)
    : null
  if (activeGroupBranchId !== group.baseBranchId) {
    return terminalTurnTarget
      ?? messages.find(message => message.branchId === activeGroupBranchId && actionMessageIds.has(message.id))?.id
      ?? null
  }
  if (terminalTurnTarget)
    return terminalTurnTarget
  const forkIndex = messages.findIndex(message => message.id === group.forkedFromMessageId)
  return forkIndex >= 0 ? messages.slice(forkIndex + 1).find(message => message.branchId === activeGroupBranchId && actionMessageIds.has(message.id))?.id ?? null : null
}

function resolveTerminalTurnTarget(
  branchId: string,
  triggeringMessageId: string,
  actionTurns: ReadonlyArray<ChatAgentTurn>,
): string | null {
  return actionTurns.find(turn => (
    turn.branchId === branchId
    && turn.triggeringMessageId === triggeringMessageId
    && turn.status !== 'queued'
    && turn.status !== 'running'
  ))?.runId ?? null
}
