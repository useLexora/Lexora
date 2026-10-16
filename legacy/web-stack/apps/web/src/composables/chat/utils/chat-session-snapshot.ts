import type { ChatSessionDetail } from '@/apis/chat'

export interface ChatSessionSnapshotState {
  activeSessionId: string | null
  activeSession: ChatSessionDetail | null
  requestEpoch: number
  requestEpochBySessionId: Map<string, number>
  latestSequenceBySessionId: Map<string, number>
}

export function createChatSessionSnapshotState(): ChatSessionSnapshotState {
  return {
    activeSessionId: null,
    activeSession: null,
    requestEpoch: 0,
    requestEpochBySessionId: new Map(),
    latestSequenceBySessionId: new Map(),
  }
}

export function beginChatSessionSnapshotRequest(
  state: ChatSessionSnapshotState,
  sessionId: string,
): number {
  const nextEpoch = state.requestEpoch + 1
  state.requestEpoch = nextEpoch
  state.activeSessionId = sessionId
  state.requestEpochBySessionId.set(sessionId, nextEpoch)

  if (state.activeSession?.id !== sessionId) {
    state.activeSession = null
  }

  return nextEpoch
}

export function acceptChatSessionSnapshot(
  state: ChatSessionSnapshotState,
  input: {
    session: ChatSessionDetail
    requestEpoch?: number
  },
): boolean {
  if (state.activeSessionId !== null && state.activeSessionId !== input.session.id) {
    return false
  }

  if (input.requestEpoch !== undefined && state.requestEpochBySessionId.get(input.session.id) !== input.requestEpoch) {
    return false
  }

  const currentLatestSequence = state.latestSequenceBySessionId.get(input.session.id)
    ?? (state.activeSession?.id === input.session.id ? state.activeSession.latestSequence : undefined)

  if (currentLatestSequence !== undefined && input.session.latestSequence < currentLatestSequence) {
    return false
  }

  state.activeSessionId = input.session.id
  state.activeSession = input.session
  state.latestSequenceBySessionId.set(input.session.id, input.session.latestSequence)
  return true
}

export function setActiveChatSessionSnapshot(
  state: ChatSessionSnapshotState,
  session: ChatSessionDetail,
): void {
  state.activeSessionId = session.id
  state.activeSession = session
  state.latestSequenceBySessionId.set(session.id, session.latestSequence)
}

export function clearActiveChatSessionSnapshot(state: ChatSessionSnapshotState): void {
  state.activeSessionId = null
  state.activeSession = null
}
