import type { ChatApi } from './createChatApi'
import type { ChatSessionSummaryPatch } from './utils/chat-session-summary'
import type { ChatSessionDetail, ChatSessionSummary } from '@/apis/chat'
import { shallowReactive, shallowRef, toRef } from 'vue'
import { translate } from '@/i18n'
import { ElMessage } from '@/utils/element-plus'
import { getRequestErrorDisplayMessage } from '@/utils/request-error'
import {
  acceptChatSessionSnapshot,
  beginChatSessionSnapshotRequest,
  clearActiveChatSessionSnapshot,
  createChatSessionSnapshotState,
  setActiveChatSessionSnapshot,
} from './utils/chat-session-snapshot'
import {
  patchChatSessionSummary,
  reconcileLoadedChatSessionSummaries,
  replaceChatSessionSummary,
  upsertChatSessionSummary,
} from './utils/chat-session-summary'

export interface ChatSession extends ChatSessionSummary {}
export interface ActiveChatSession extends ChatSessionDetail {}

export interface ChatSessionPersistence {
  rememberActive: (id: string) => void
  forgetActive: (id?: string) => void
}

export function createChatSessionController(
  api: ChatApi,
  options: { persistence?: ChatSessionPersistence } = {},
) {
  const { persistence } = options
  const snapshotState = shallowReactive(createChatSessionSnapshotState())
  const sessions = shallowRef<ChatSession[]>([])
  const activeSessionId = toRef(snapshotState, 'activeSessionId')
  const activeSession = toRef(snapshotState, 'activeSession')
  const isLoadingSessions = shallowRef(false)

  async function loadSessions(loadOptions: {
    preserveActiveSessionId?: boolean
    selectFallbackSession?: boolean
  } = {}) {
    const {
      preserveActiveSessionId = true,
      selectFallbackSession = true,
    } = loadOptions
    isLoadingSessions.value = true

    try {
      const nextSessions = await api.getSessions()
      setLoadedSessionSummaries(nextSessions)

      if (nextSessions.length === 0) {
        clearActiveChatSessionSnapshot(snapshotState)
        return
      }

      if (!selectFallbackSession) {
        return
      }

      const nextActiveSessionId = preserveActiveSessionId && activeSessionId.value && nextSessions.some(session => session.id === activeSessionId.value)
        ? activeSessionId.value
        : nextSessions[0].id

      if (!nextActiveSessionId) {
        clearActiveChatSessionSnapshot(snapshotState)
        return
      }

      await selectSession(nextActiveSessionId)
    }
    catch (error) {
      ElMessage.error(getRequestErrorDisplayMessage(error, translate('chat.errors.loadSession')))
    }
    finally {
      isLoadingSessions.value = false
    }
  }

  async function createSession() {
    try {
      const session = await api.createSession()
      upsertSessionSummary(session)
      setActiveChatSessionSnapshot(snapshotState, session)
      rememberActiveSession(session.id)
      return session
    }
    catch (error) {
      ElMessage.error(getRequestErrorDisplayMessage(error, translate('chat.errors.createSession')))
      return null
    }
  }

  async function ensureActiveSession() {
    if (activeSession.value) {
      return activeSession.value
    }

    if (activeSessionId.value) {
      await selectSession(activeSessionId.value)
      return activeSession.value
    }

    return createSession()
  }

  function clearActiveSession() {
    clearActiveChatSessionSnapshot(snapshotState)
  }

  function replaceActiveSession(session: ActiveChatSession) {
    const accepted = acceptChatSessionSnapshot(snapshotState, {
      session,
    })
    if (!accepted) {
      return false
    }

    patchSessionSummary(session.id, {
      agentProfile: session.agentProfile,
      modelRef: session.modelRef,
      title: session.title,
      updatedAt: session.updatedAt,
    })
    rememberActiveSession(session.id)
    return true
  }

  async function selectSession(id: string) {
    const isCurrentSession = activeSession.value?.id === id

    if (isCurrentSession) {
      rememberActiveSession(id)
      return true
    }

    const requestEpoch = beginChatSessionSnapshotRequest(snapshotState, id)

    try {
      const session = await api.getSession(id)
      const accepted = acceptChatSessionSnapshot(snapshotState, {
        session,
        requestEpoch,
      })

      if (accepted) {
        syncSessionSummary(session)
        rememberActiveSession(id)
      }

      return accepted
    }
    catch (error) {
      clearActiveChatSessionSnapshot(snapshotState)
      forgetActiveSession(id)
      ElMessage.error(getRequestErrorDisplayMessage(error, translate('chat.errors.loadSession')))
      return false
    }
  }

  async function deleteSession(id: string, deleteOptions: { selectFallbackSession?: boolean } = {}) {
    const { selectFallbackSession = true } = deleteOptions

    try {
      await api.deleteSession(id)
      sessions.value = sessions.value.filter(session => session.id !== id)
      forgetActiveSession(id)

      if (activeSessionId.value !== id) {
        return activeSessionId.value
      }

      if (!selectFallbackSession) {
        clearActiveChatSessionSnapshot(snapshotState)
        return null
      }

      const nextSession = sessions.value[0]
      if (!nextSession) {
        clearActiveChatSessionSnapshot(snapshotState)
        return null
      }

      return await selectSession(nextSession.id) ? nextSession.id : null
    }
    catch (error) {
      ElMessage.error(getRequestErrorDisplayMessage(error, translate('chat.errors.deleteSession')))
      return activeSessionId.value
    }
  }

  async function batchDeleteSessions(ids: string[]) {
    const sessionIds = [...new Set(ids.map(id => id.trim()).filter(Boolean))]

    if (sessionIds.length === 0) {
      return {
        nextActiveSessionId: activeSessionId.value,
        deletedSessionIds: [],
      }
    }

    try {
      const { deletedSessionIds } = await api.batchDeleteSessions({ sessionIds })
      const deletedSessionIdSet = new Set(deletedSessionIds)
      sessions.value = sessions.value.filter(session => !deletedSessionIdSet.has(session.id))

      for (const deletedSessionId of deletedSessionIds) {
        forgetActiveSession(deletedSessionId)
      }

      if (!activeSessionId.value || !deletedSessionIdSet.has(activeSessionId.value)) {
        return {
          nextActiveSessionId: activeSessionId.value,
          deletedSessionIds,
        }
      }

      const nextSession = sessions.value[0]
      if (!nextSession) {
        clearActiveChatSessionSnapshot(snapshotState)
        return {
          nextActiveSessionId: null,
          deletedSessionIds,
        }
      }

      return {
        nextActiveSessionId: await selectSession(nextSession.id) ? nextSession.id : null,
        deletedSessionIds,
      }
    }
    catch (error) {
      ElMessage.error(getRequestErrorDisplayMessage(error, translate('chat.errors.batchDeleteSessions')))
      return {
        nextActiveSessionId: activeSessionId.value,
        deletedSessionIds: [],
      }
    }
  }

  async function renameSession(id: string, title: string) {
    const nextTitle = title.trim()

    if (!nextTitle) {
      ElMessage.warning(translate('chat.session.renameRequired'))
      return false
    }

    try {
      const updatedSession = await api.updateSessionTitle(id, {
        title: nextTitle,
      })

      if (activeSessionId.value === id) {
        replaceActiveSession(updatedSession)
      }
      else {
        patchSessionSummary(id, {
          title: updatedSession.title,
          updatedAt: updatedSession.updatedAt,
        })
      }

      ElMessage.success(translate('chat.session.renamed'))
      return true
    }
    catch (error) {
      ElMessage.error(getRequestErrorDisplayMessage(error, translate('chat.errors.renameSession')))
      return false
    }
  }

  async function refreshActiveSession(sessionId: string) {
    const requestEpoch = beginChatSessionSnapshotRequest(snapshotState, sessionId)

    try {
      const session = await api.getSession(sessionId)
      const accepted = acceptChatSessionSnapshot(snapshotState, {
        session,
        requestEpoch,
      })
      if (!accepted) {
        return null
      }

      syncSessionSummary(session)
      return session
    }
    catch (error) {
      ElMessage.error(getRequestErrorDisplayMessage(error, translate('chat.errors.loadSession')))
      return null
    }
  }

  function setLoadedSessionSummaries(nextSessions: ChatSessionSummary[]) {
    sessions.value = reconcileLoadedChatSessionSummaries(nextSessions, activeSession.value)
  }

  function upsertSessionSummary(session: ChatSessionSummary) {
    sessions.value = upsertChatSessionSummary(sessions.value, session)
  }

  function syncSessionSummary(session: ChatSessionSummary) {
    const currentSummary = sessions.value.find(item => item.id === session.id)
    if (!currentSummary) {
      return
    }

    sessions.value = session.updatedAt > currentSummary.updatedAt
      ? upsertChatSessionSummary(sessions.value, session)
      : replaceChatSessionSummary(sessions.value, session)
  }

  function patchSessionSummary(
    sessionId: string,
    input: ChatSessionSummaryPatch,
  ) {
    sessions.value = patchChatSessionSummary(
      sessions.value,
      sessionId,
      input,
      activeSession.value,
    )
  }

  function rememberActiveSession(id: string) {
    persistence?.rememberActive(id)
  }

  function forgetActiveSession(id?: string) {
    persistence?.forgetActive(id)
  }

  return {
    activeSession,
    activeSessionId,
    batchDeleteSessions,
    clearActiveSession,
    createSession,
    deleteSession,
    ensureActiveSession,
    isLoadingSessions,
    loadSessions,
    patchSessionSummary,
    refreshActiveSession,
    renameSession,
    replaceActiveSession,
    selectSession,
    sessions,
  }
}

export type ChatSessionController = ReturnType<typeof createChatSessionController>
