import type { ChatSessionDetail, ChatSessionSummary } from '@/apis/chat'

export type ChatSessionSummaryPatch = Partial<Pick<ChatSessionSummary, 'agentProfile' | 'modelRef' | 'title' | 'updatedAt'>>

export function toChatSessionSummary(session: ChatSessionSummary | ChatSessionDetail): ChatSessionSummary {
  return {
    id: session.id,
    workspaceId: session.workspaceId,
    origin: session.origin,
    channel: session.channel,
    title: session.title,
    agentProfile: session.agentProfile,
    modelRef: session.modelRef,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  }
}

export function upsertChatSessionSummary(
  sessions: ChatSessionSummary[],
  session: ChatSessionSummary | ChatSessionDetail,
): ChatSessionSummary[] {
  const summary = toChatSessionSummary(session)

  return [
    summary,
    ...sessions.filter(item => item.id !== summary.id),
  ]
}

export function replaceChatSessionSummary(
  sessions: ChatSessionSummary[],
  session: ChatSessionSummary | ChatSessionDetail,
): ChatSessionSummary[] {
  const summary = toChatSessionSummary(session)
  let replaced = false

  const nextSessions = sessions.map((item) => {
    if (item.id !== summary.id) {
      return item
    }

    replaced = true
    return summary
  })

  return replaced ? nextSessions : sessions
}

export function reconcileLoadedChatSessionSummaries(
  loadedSessions: ChatSessionSummary[],
  currentSession: ChatSessionSummary | ChatSessionDetail | null | undefined,
): ChatSessionSummary[] {
  if (!currentSession) {
    return loadedSessions
  }

  const currentSummary = toChatSessionSummary(currentSession)
  const loadedSummary = loadedSessions.find(session => session.id === currentSummary.id)
  if (!loadedSummary || loadedSummary.updatedAt >= currentSummary.updatedAt) {
    return loadedSessions
  }

  return upsertChatSessionSummary(loadedSessions, currentSummary)
}

export function patchChatSessionSummary(
  sessions: ChatSessionSummary[],
  sessionId: string,
  input: ChatSessionSummaryPatch,
  fallbackSession?: ChatSessionSummary | ChatSessionDetail | null,
): ChatSessionSummary[] {
  const targetSession = sessions.find(session => session.id === sessionId)
    ?? (fallbackSession?.id === sessionId ? toChatSessionSummary(fallbackSession) : null)

  if (!targetSession) {
    return sessions
  }

  return upsertChatSessionSummary(sessions, {
    ...targetSession,
    ...input,
  })
}
