import { useDocsChatEngine } from './useDocsChatEngine'

export function useDocsChatSessions() {
  return useDocsChatEngine().sessions
}

export type DocsChatSessions = ReturnType<typeof useDocsChatSessions>
