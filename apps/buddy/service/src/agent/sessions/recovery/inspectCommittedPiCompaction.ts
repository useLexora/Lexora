import type { Usage } from '@earendil-works/pi-ai'
import { createHash } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import {
  estimateTokens,
  getLatestCompactionEntry,
  SessionManager,
} from '@earendil-works/pi-coding-agent'
import { containsCanonicalPath } from '../../../../../platform/filesystem/filePaths'
import {
  BuddySessionCreationError,
  isMissingBuddySessionFile,
  toBuddySessionStorageError,
} from '../BuddySessionErrors'

import { readCheckpoint } from '../tree/BuddyTreeStore'

const sessionIdentityPattern = /^[A-Z0-9][\w-]{0,127}$/i

export interface InspectCommittedPiCompactionOptions {
  runId?: string
  threadId?: string
  branchId: string
  conversationsDirectory: string
  conversationId: string
  piSessionFile: string
  startedAt: string
}

export interface CommittedPiCompactionEvidence {
  compactionEntryId: string
  estimatedTokensAfter: number
  firstKeptEntryId: string
  tokensBefore: number
  usage?: Usage
}

export async function inspectCommittedPiCompaction(
  options: InspectCommittedPiCompactionOptions,
): Promise<CommittedPiCompactionEvidence | null> {
  validateIdentity(options.conversationId)
  validateIdentity(options.branchId)
  const base = resolve(options.conversationsDirectory, options.conversationId, 'session')
  const file = resolve(options.piSessionFile)
  const threadDirectory = options.threadId
    ? resolve(base, 'threads', createHash('sha256').update(options.threadId).digest('hex'))
    : null
  const threaded = containsCanonicalPath(resolve(base, 'threads'), file)
  const sessionDirectory = threaded ? threadDirectory : base
  if (!isAbsolute(options.piSessionFile) || !options.piSessionFile.endsWith('.jsonl')
    || !sessionDirectory || !containsCanonicalPath(sessionDirectory, file)) {
    throw new BuddySessionCreationError()
  }

  try {
    const [canonicalSessionDirectory, canonicalSessionFile] = await Promise.all([
      realpath(sessionDirectory),
      realpath(options.piSessionFile),
    ])
    if (!containsCanonicalPath(canonicalSessionDirectory, canonicalSessionFile))
      throw new BuddySessionCreationError()
    const manager = SessionManager.open(canonicalSessionFile, canonicalSessionDirectory)
    const roots = manager.getEntries().filter(entry => entry.type === 'custom' && entry.customType === 'lexora.conversation.root.v1')
    if (roots.length) {
      if (!roots.some(entry => entry.type === 'custom' && entry.data && typeof entry.data === 'object'
        && 'conversationId' in entry.data && entry.data.conversationId === options.conversationId
        && (!threaded || ('threadId' in entry.data && entry.data.threadId === options.threadId)))) {
        throw new BuddySessionCreationError()
      }
    }
    else if (threaded || dirname(canonicalSessionFile) !== resolve(canonicalSessionDirectory, options.branchId)) {
      throw new BuddySessionCreationError()
    }
    if (options.runId && roots.length) {
      const after = manager.getEntries().findLast((entry) => {
        const checkpoint = readCheckpoint(entry)
        return checkpoint !== null && checkpoint.runId === options.runId && checkpoint.branchId === options.branchId && checkpoint.position === 'after'
      })
      if (after)
        manager.branch(after.id)
      const latest = manager.getBranch().findLast(entry => readCheckpoint(entry))
      const checkpoint = latest ? readCheckpoint(latest) : null
      if (!checkpoint || checkpoint.runId !== options.runId || checkpoint.branchId !== options.branchId)
        return null
    }
    const branch = manager.getBranch()
    const compaction = getLatestCompactionEntry(branch)
    if (options.runId && compaction && roots.length) {
      const before = branch.findIndex((entry) => {
        const checkpoint = readCheckpoint(entry)
        return checkpoint !== null && checkpoint.runId === options.runId && checkpoint.position === 'before'
      })
      if (before < 0 || branch.findIndex(entry => entry.id === compaction.id) <= before)
        return null
    }
    const startedAt = Date.parse(options.startedAt)
    const committedAt = compaction ? Date.parse(compaction.timestamp) : Number.NaN
    if (!compaction || !Number.isFinite(startedAt) || committedAt < startedAt)
      return null
    const estimatedTokensAfter = manager.buildSessionContext().messages.reduce(
      (total, message) => total + estimateTokens(message),
      0,
    )
    return {
      compactionEntryId: compaction.id,
      estimatedTokensAfter,
      firstKeptEntryId: compaction.firstKeptEntryId,
      tokensBefore: compaction.tokensBefore,
      ...(compaction.usage ? { usage: compaction.usage } : {}),
    }
  }
  catch (error) {
    if (error instanceof BuddySessionCreationError)
      throw error
    if (isMissingBuddySessionFile(error))
      return null
    const storageError = toBuddySessionStorageError(error)
    if (storageError)
      throw storageError
    return null
  }
}

function validateIdentity(value: string): void {
  if (!sessionIdentityPattern.test(value))
    throw new BuddySessionCreationError()
}
