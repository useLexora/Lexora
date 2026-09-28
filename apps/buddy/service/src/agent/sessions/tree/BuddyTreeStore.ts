import type { FileEntry, SessionEntry } from '@earendil-works/pi-coding-agent'
import type { ConversationTreeRepository } from '../../../storage/conversationTreeRepository'
import type { RunRecord } from '../../../storage/runRecord'
import type { BuddyTreeFact } from './BuddyTreeEvents'
import { randomUUID } from 'node:crypto'
import { appendFileSync, closeSync, fsyncSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdir, realpath } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import { containsCanonicalPath } from '../../../../../platform/filesystem/filePaths'
import { BuddyAgentRunError } from '../../../runs/runError'
import { toBuddySessionStorageError } from '../BuddySessionErrors'
import { BuddyTreeEvents } from './BuddyTreeEvents'

const CHECKPOINT_TYPE = 'lexora.conversation.checkpoint.v1'
const ROOT_TYPE = 'lexora.conversation.root.v1'

export interface TreeCheckpoint {
  runId: string
  branchId: string
  position: 'before' | 'after'
  legacy?: boolean
}

interface BuddyTreeStoreOptions {
  conversationsDirectory: string
  repository: Pick<ConversationTreeRepository, 'findBinding' | 'bind'>
  onObserverError?: (error: unknown) => void
}

export class BuddyTreeStore {
  readonly #options: BuddyTreeStoreOptions
  readonly #events: BuddyTreeEvents
  readonly onDidCommit: BuddyTreeEvents['onDidCommit']
  readonly onDidFail: BuddyTreeEvents['onDidFail']

  constructor(options: BuddyTreeStoreOptions) {
    this.#options = options
    this.#events = new BuddyTreeEvents(options.onObserverError)
    this.onDidCommit = this.#events.onDidCommit
    this.onDidFail = this.#events.onDidFail
  }

  async open(conversationId: string, cwd: string) {
    this.#events.assertOpen()
    const operationId = randomUUID()
    let stage: 'open' | 'binding' = 'open'
    try {
      return await this.#open(conversationId, cwd, operationId, () => {
        stage = 'binding'
      })
    }
    catch (error) {
      this.#events.fail(conversationId, stage, error, operationId)
      throw toBuddySessionStorageError(error) ?? error
    }
  }

  async #open(conversationId: string, cwd: string, operationId: string, beforeBinding: () => void) {
    const binding = this.#options.repository.findBinding(conversationId)
    const directory = await this.#directory(conversationId)
    let manager: SessionManager | undefined
    let rootId: string | undefined
    if (binding) {
      if (!containsCanonicalPath(directory, resolve(binding.sessionFile)))
        throw new BuddyAgentRunError('CONVERSATION_BINDING_MISMATCH')
      try {
        const path = await realpath(binding.sessionFile)
        if (!containsCanonicalPath(directory, path))
          throw new BuddyAgentRunError('CONVERSATION_BINDING_MISMATCH')
        readSessionEntries(path)
        manager = SessionManager.open(path, directory, cwd)
        const root = manager.getEntry(binding.rootEntryId)
        if (root?.type !== 'custom' || root.customType !== ROOT_TYPE)
          throw new InvalidPiTreeError()
        if ((root.data as { conversationId?: unknown })?.conversationId !== conversationId)
          throw new BuddyAgentRunError('CONVERSATION_BINDING_MISMATCH')
        rootId = binding.rootEntryId
      }
      catch (error) {
        if (!(error instanceof InvalidPiTreeError) && !isMissingFile(error))
          throw error
        manager = undefined
      }
    }
    if (!manager || !rootId) {
      const path = join(directory, binding ? `tree-${randomUUID()}.jsonl` : 'tree.jsonl')
      const seed = SessionManager.inMemory(cwd)
      rootId = seed.appendCustomEntry(ROOT_TYPE, { conversationId })
      let created = false
      try {
        const fd = openSync(path, 'wx', 0o600)
        try {
          writeFileSync(fd, `${[seed.getHeader()!, ...seed.getEntries()].map(entry => JSON.stringify(entry)).join('\n')}\n`)
          fsyncSync(fd)
          created = true
          this.#events.commit({ kind: 'file.created', conversationId, operationId, treeId: rootId })
        }
        finally {
          closeSync(fd)
        }
      }
      catch (error) {
        if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'EEXIST')
          throw error
        readSessionEntries(path)
        const existing = SessionManager.open(path, directory, cwd)
        const root = existing.getEntries().find(entry => entry.type === 'custom' && entry.customType === ROOT_TYPE)
        if (!root || root.type !== 'custom' || (root.data as { conversationId?: unknown })?.conversationId !== conversationId)
          throw new BuddyAgentRunError('SESSION_STORAGE_UNAVAILABLE')
        rootId = root.id
      }
      manager = SessionManager.open(path, directory, cwd)
      beforeBinding()
      this.#options.repository.bind(conversationId, path, rootId)
      this.#events.commit({ kind: 'binding.committed', conversationId, operationId, treeId: rootId, reason: binding ? 'replaced' : created ? 'created' : 'reconciled' })
    }
    return new BuddyTreeJournal(manager, rootId, directory, conversationId, this.#events)
  }

  async read(conversationId: string, cwd: string) {
    this.#events.assertOpen()
    const binding = this.#options.repository.findBinding(conversationId)
    if (!binding)
      return null
    const directory = await this.#directory(conversationId)
    let path: string
    try {
      path = await realpath(binding.sessionFile)
      readSessionEntries(path)
    }
    catch (error) {
      if (isMissingFile(error) || error instanceof InvalidPiTreeError)
        return null
      throw error
    }
    if (!containsCanonicalPath(directory, path))
      throw new BuddyAgentRunError('CONVERSATION_BINDING_MISMATCH')
    const manager = SessionManager.open(path, directory, cwd)
    const root = manager.getEntry(binding.rootEntryId)
    if (root?.type !== 'custom' || (root.data as { conversationId?: unknown })?.conversationId !== conversationId)
      throw new BuddyAgentRunError('CONVERSATION_BINDING_MISMATCH')
    if (root.customType !== ROOT_TYPE)
      throw new BuddyAgentRunError('CONVERSATION_BINDING_MISMATCH')
    const snapshot = SessionManager.inMemory(cwd, undefined, [manager.getHeader()!, ...manager.getEntries()])
    return { manager: snapshot, rootId: binding.rootEntryId, validateAncestry: (id: string) => validateAncestry(snapshot, id, binding.rootEntryId) }
  }

  async readLegacy(conversationId: string, cwd: string, sessionFile: string | null) {
    this.#events.assertOpen()
    if (!sessionFile)
      return null
    return readLegacySession(await this.#directory(conversationId), sessionFile, cwd)
  }

  async #directory(conversationId: string) {
    if (!/^[A-Z0-9][\w-]{0,127}$/i.test(conversationId))
      throw new BuddyAgentRunError('CONVERSATION_BINDING_MISMATCH')
    const directory = join(this.#options.conversationsDirectory, conversationId, 'session')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const canonical = await realpath(directory)
    if (!containsCanonicalPath(await realpath(this.#options.conversationsDirectory), canonical))
      throw new BuddyAgentRunError('CONVERSATION_BINDING_MISMATCH')
    return canonical
  }

  dispose() {
    this.#events.dispose()
  }
}

export class BuddyTreeJournal {
  readonly #checkpoints = new Map<string, string>()
  readonly #events: BuddyTreeEvents
  readonly #conversationId: string
  #failed = false

  readonly manager: SessionManager
  readonly rootId: string
  readonly directory: string

  constructor(manager: SessionManager, rootId: string, directory: string, conversationId: string, events: BuddyTreeEvents) {
    this.manager = manager
    this.rootId = rootId
    this.directory = directory
    this.#conversationId = conversationId
    this.#events = events
    this.#index()
  }

  findCheckpoint(runId: string, position: TreeCheckpoint['position']) {
    const id = this.#checkpoints.get(`${runId}:${position}`)
    if (id)
      this.validateAncestry(id)
    return id
  }

  appendCheckpoint(run: RunRecord, position: TreeCheckpoint['position'], parentId = this.manager.getLeafId()!, recovery?: Extract<BuddyTreeFact, { kind: 'checkpoint.committed' }>['recovery']) {
    this.#assertWritable()
    const existing = this.findCheckpoint(run.id, position)
    if (existing)
      return existing
    const operationId = randomUUID()
    const previousLeaf = this.manager.getLeafId()!
    try {
      this.manager.branch(parentId)
      const id = this.manager.appendCustomEntry(CHECKPOINT_TYPE, { runId: run.id, branchId: run.branchId, position, legacy: recovery?.source === 'legacy' || recovery?.source === 'product_history' } satisfies TreeCheckpoint)
      syncSession(this.manager)
      this.#checkpoints.set(`${run.id}:${position}`, id)
      this.#events.commit({ kind: 'checkpoint.committed', operationId, conversationId: this.#conversationId, treeId: this.rootId, runId: run.id, branchId: run.branchId, checkpointId: id, position, ...(recovery ? { recovery } : {}) })
      return id
    }
    catch (error) {
      this.#failed = true
      this.#events.fail(this.#conversationId, 'checkpoint', error, operationId)
      throw toBuddySessionStorageError(error) ?? error
    }
    finally {
      this.manager.branch(previousLeaf)
    }
  }

  appendRecoveredMessages(run: RunRecord, position: TreeCheckpoint['position'], messages: readonly Parameters<SessionManager['appendMessage']>[0][], recovery: { missingAttachmentCount: number, recoveredImageCount: number }) {
    this.#assertWritable()
    const existing = this.findCheckpoint(run.id, position)
    if (existing)
      return existing
    const previousLeaf = this.manager.getLeafId()!
    this.manager.branch(this.rootId)
    try {
      for (const message of messages)
        this.manager.appendMessage(message)
      return this.appendCheckpoint(run, position, this.manager.getLeafId()!, { source: 'product_history', ...recovery })
    }
    catch (error) {
      if (!this.#failed) {
        this.#failed = true
        this.#events.fail(this.#conversationId, 'checkpoint', error)
      }
      throw toBuddySessionStorageError(error) ?? error
    }
    finally {
      this.manager.branch(previousLeaf)
    }
  }

  appendEntries(run: RunRecord, entries: readonly FileEntry[]) {
    this.#assertWritable()
    if (!entries.length)
      return
    const previousLeaf = this.manager.getLeafId()!
    const sessionFile = this.manager.getSessionFile()!
    const operationId = randomUUID()
    let stage: 'import' | 'import_index' = 'import'
    try {
      appendFileSync(sessionFile, `${entries.map(entry => JSON.stringify(entry)).join('\n')}\n`)
      syncSession(this.manager)
      this.#events.commit({ kind: 'entries.imported', operationId, conversationId: this.#conversationId, treeId: this.rootId, runId: run.id, branchId: run.branchId, entryCount: entries.length })
      stage = 'import_index'
      this.manager.setSessionFile(sessionFile)
      this.manager.branch(previousLeaf)
      this.#index()
    }
    catch (error) {
      this.#failed = true
      this.#events.fail(this.#conversationId, stage, error, operationId)
      throw toBuddySessionStorageError(error) ?? error
    }
  }

  readLegacy(sessionFile: string | null) {
    return readLegacySession(this.directory, sessionFile, this.manager.getCwd())
  }

  validateAncestry(id: string) {
    validateAncestry(this.manager, id, this.rootId)
  }

  assertConversation(conversationId: string) {
    const root = this.manager.getEntry(this.rootId)
    if (root?.type !== 'custom' || (root.data as { conversationId?: unknown })?.conversationId !== conversationId)
      throw new BuddyAgentRunError('CONVERSATION_BINDING_MISMATCH')
  }

  #index() {
    for (const entry of this.manager.getEntries()) {
      const checkpoint = readCheckpoint(entry)
      if (checkpoint)
        this.#checkpoints.set(`${checkpoint.runId}:${checkpoint.position}`, entry.id)
    }
  }

  #assertWritable() {
    this.#events.assertOpen()
    if (this.#failed)
      throw new BuddyAgentRunError('SESSION_STORAGE_UNAVAILABLE')
  }
}

export function readCheckpoint(entry: SessionEntry): TreeCheckpoint | null {
  if (entry.type !== 'custom' || entry.customType !== CHECKPOINT_TYPE || !entry.data || typeof entry.data !== 'object')
    return null
  const data = entry.data as Partial<TreeCheckpoint>
  return typeof data.runId === 'string' && typeof data.branchId === 'string' && (data.position === 'before' || data.position === 'after') ? data as TreeCheckpoint : null
}

function validateAncestry(manager: SessionManager, id: string, rootId: string) {
  const visited = new Set<string>()
  let cursor: string | null = id
  while (cursor && !visited.has(cursor)) {
    if (cursor === rootId)
      return
    visited.add(cursor)
    const entry = manager.getEntry(cursor)
    if (!entry)
      break
    cursor = entry.parentId
  }
  throw new BuddyAgentRunError('SESSION_STORAGE_UNAVAILABLE')
}

function syncSession(manager: SessionManager) {
  try {
    const fd = openSync(manager.getSessionFile()!, 'r+')
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

class InvalidPiTreeError extends Error { }

function isMissingFile(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'
}

function readSessionEntries(path: string): FileEntry[] {
  const buffer = readFileSync(path)
  try {
    const entries: FileEntry[] = []
    let start = 0
    while (start < buffer.length) {
      let end = buffer.indexOf(0x0A, start)
      if (end === -1)
        end = buffer.length
      let lineStart = start
      let lineEnd = end
      start = end + 1
      while (lineStart < lineEnd && buffer[lineStart]! <= 0x20)
        lineStart++
      while (lineEnd > lineStart && buffer[lineEnd - 1]! <= 0x20)
        lineEnd--
      if (lineStart >= lineEnd)
        continue
      const line = buffer.toString('utf8', lineStart, lineEnd)
      entries.push(JSON.parse(line))
    }
    if (!entries.length || entries[0]?.type !== 'session')
      throw new InvalidPiTreeError()
    const ids = new Set<string>()
    for (const entry of entries.slice(1)) {
      if (entry.type === 'session' || typeof entry.id !== 'string' || ids.has(entry.id)
        || (entry.parentId !== null && !ids.has(entry.parentId))) {
        throw new InvalidPiTreeError()
      }
      ids.add(entry.id)
    }
    return entries
  }
  catch {
    throw new InvalidPiTreeError()
  }
}

async function readLegacySession(directory: string, sessionFile: string | null, cwd: string) {
  if (!sessionFile || !isAbsolute(sessionFile))
    return null
  try {
    const path = await realpath(sessionFile)
    if (!containsCanonicalPath(directory, path))
      throw new BuddyAgentRunError('CONVERSATION_BINDING_MISMATCH')
    return { path, manager: SessionManager.inMemory(cwd, undefined, readSessionEntries(path)) }
  }
  catch (error) {
    if (isMissingFile(error) || error instanceof InvalidPiTreeError)
      return null
    throw toBuddySessionStorageError(error) ?? error
  }
}
