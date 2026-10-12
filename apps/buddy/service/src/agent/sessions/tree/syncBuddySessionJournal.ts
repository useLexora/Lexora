import type { SessionManager } from '@earendil-works/pi-coding-agent'
import { closeSync, fsyncSync, openSync } from 'node:fs'
import { BuddyAgentRunError } from '../../../runs/runError'
import { toBuddySessionStorageError } from '../BuddySessionErrors'

export function syncBuddySessionJournal(manager: SessionManager): void {
  const path = manager.getSessionFile()
  if (!path)
    throw new BuddyAgentRunError('SESSION_STORAGE_UNAVAILABLE')
  try {
    const fd = openSync(path, 'r+')
    try {
      fsyncSync(fd)
    }
    finally {
      closeSync(fd)
    }
  }
  catch (error) {
    throw toBuddySessionStorageError(error) ?? error
  }
}
