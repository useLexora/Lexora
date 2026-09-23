import type { FileEntry, SessionEntry } from '@earendil-works/pi-coding-agent'
import type { ConversationTreeRepository } from '../../../storage/conversationTreeRepository'
import type { RunRecord } from '../../../storage/runRecord'
import { randomUUID } from 'node:crypto'
import { appendFileSync, closeSync, fsyncSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdir, realpath } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import { containsCanonicalPath } from '../../../../../platform/filesystem/filePaths'
import { BuddyAgentRunError } from '../../../runs/runError'
import { toBuddySessionStorageError } from '../BuddySessionErrors'

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
  repository: ConversationTreeRepository
}

export class BuddyTreeStore {
  readonly options: BuddyTreeStoreOptions

  constructor(options: BuddyTreeStoreOptions) {
    this.options = options
  }

  async open(conversationId: string, cwd: string) {
    try {
      return await this.#open(conversationId, cwd)
    }
    catch (error) {
      throw toBuddySessionStorageError(error) ?? error
    }
  }

  async #open(conversationId: string, cwd: string) {
    const binding = this.options.repository.findBinding(conversationId)
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
      try {
        const fd = openSync(path, 'wx', 0o600)
        try {
          writeFileSync(fd, `${[seed.getHeader()!, ...seed.getEntries()].map(entry => JSON.stringify(entry)).join('\n')}\n`)
          fsyncSync(fd)
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
      this.options.repository.bind(conversationId, path, rootId)
    }
    return new BuddyTreeJournal(manager, rootId, directory)
  }

  async read(conversationId: string, cwd: string): Promise<BuddyTreeJournal | null> {
    const binding = this.options.repository.findBinding(conversationId)
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
    return new BuddyTreeJournal(manager, binding.rootEntryId, directory)
  }

  async readLegacy(conversationId: string, cwd: string, sessionFile: string | null) {
    if (!sessionFile)
      return null
    return readLegacySession(await this.#directory(conversationId), sessionFile, cwd)
  }

  async #directory(conversationId: string) {
    if (!/^[A-Z0-9][\w-]{0,127}$/i.test(conversationId))
      throw new BuddyAgentRunError('CONVERSATION_BINDING_MISMATCH')
    const directory = join(this.options.conversationsDirectory, conversationId, 'session')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const canonical = await realpath(directory)
    if (!containsCanonicalPath(await realpath(this.options.conversationsDirectory), canonical))
      throw new BuddyAgentRunError('CONVERSATION_BINDING_MISMATCH')
    return canonical
  }
}

export class BuddyTreeJournal {
  readonly #checkpoints = new Map<string, string>()

  readonly manager: SessionManager
  readonly rootId: string
  readonly directory: string

  constructor(manager: SessionManager, rootId: string, directory: string) {
    this.manager = manager
    this.rootId = rootId
    this.directory = directory
    this.#index()
  }

  findCheckpoint(runId: string, position: TreeCheckpoint['position']) {
    const id = this.#checkpoints.get(`${runId}:${position}`)
    if (id)
      this.validateAncestry(id)
    return id
  }

  appendCheckpoint(run: RunRecord, position: TreeCheckpoint['position'], parentId = this.manager.getLeafId()!, legacy = false) {
    const previousLeaf = this.manager.getLeafId()!
    this.manager.branch(parentId)
    const id = this.manager.appendCustomEntry(CHECKPOINT_TYPE, { runId: run.id, branchId: run.branchId, position, legacy } satisfies TreeCheckpoint)
    syncSession(this.manager)
    this.manager.branch(previousLeaf)
    this.#checkpoints.set(`${run.id}:${position}`, id)
    return id
  }

  appendRecoveredMessages(run: RunRecord, position: TreeCheckpoint['position'], messages: readonly Parameters<SessionManager['appendMessage']>[0][]) {
    const previousLeaf = this.manager.getLeafId()!
    this.manager.branch(this.rootId)
    try {
      for (const message of messages)
        this.manager.appendMessage(message)
      return this.appendCheckpoint(run, position, this.manager.getLeafId()!, true)
    }
    catch (error) {
      throw toBuddySessionStorageError(error) ?? error
    }
    finally {
      this.manager.branch(previousLeaf)
    }
  }

  appendEntries(entries: readonly FileEntry[]) {
    if (!entries.length)
      return
    const previousLeaf = this.manager.getLeafId()!
    const sessionFile = this.manager.getSessionFile()!
    try {
      appendFileSync(sessionFile, `${entries.map(entry => JSON.stringify(entry)).join('\n')}\n`)
      syncSession(this.manager)
      this.manager.setSessionFile(sessionFile)
      this.manager.branch(previousLeaf)
      this.#index()
    }
    catch (error) {
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
