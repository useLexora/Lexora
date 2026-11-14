import type { AgentSession } from '@earendil-works/pi-coding-agent'
import { toBuddySessionStorageError } from './BuddySessionErrors'

export async function withPiSessionStorageBoundary<TResult>(
  session: AgentSession,
  operation: () => Promise<TResult>,
): Promise<TResult> {
  try {
    return await operation()
  }
  catch (error) {
    const sessionFile = session.sessionManager.getSessionFile()
    const storageError = sessionFile
      ? toBuddySessionStorageError(error, sessionFile)
      : null
    throw storageError ?? error
  }
}
