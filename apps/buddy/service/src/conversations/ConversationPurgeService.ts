import type { DatabaseSync } from 'node:sqlite'
import { lstatSync, readdirSync, realpathSync, rmdirSync, unlinkSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { BuddyDataPaths } from '../storage/BuddyDataPaths'
import { createConversationDeletionRepository } from '../storage/conversationDeletionRepository'
import { ConversationPurgeError, ConversationPurgeRepository, isPurgeDescendant } from '../storage/conversationPurgeRepository'

export interface ConversationPurgeOptions {
  database: DatabaseSync
  home: string
}

export class ConversationPurgeService {
  private readonly paths: BuddyDataPaths
  private readonly repository: ConversationPurgeRepository
  private readonly deletion: ReturnType<typeof createConversationDeletionRepository>

  constructor(options: ConversationPurgeOptions) {
    this.paths = new BuddyDataPaths(options.home)
    this.repository = new ConversationPurgeRepository(options.database, this.paths)
    this.deletion = createConversationDeletionRepository(options.database)
  }

  async purge(id: string): Promise<void> {
    if (!this.deletion.has(id))
      return
    try {
      const manifest = this.repository.prepare(id)
      if (!manifest)
        return
      const directories = this.repository.directories(id, manifest)
      for (const directory of directories)
        this.inspect(directory)
      for (const directory of directories)
        this.remove(directory)
      this.repository.finish(id, manifest)
    }
    catch (error) {
      const code = error instanceof ConversationPurgeError ? error.code : 'CONVERSATION_PURGE_FAILED'
      this.deletion.failed(id, code, new Date().toISOString())
      throw new ConversationPurgeError(code, { cause: error })
    }
  }

  private inspect(path: string): void {
    this.assertPath(path)
    const stat = this.stat(path)
    if (!stat)
      return
    if (!stat.isDirectory() && !stat.isFile())
      throw new ConversationPurgeError('CONVERSATION_FILE_BOUNDARY')
    if (stat.isDirectory()) {
      for (const name of readdirSync(path))
        this.inspect(join(path, name))
    }
  }

  private remove(path: string): void {
    this.assertPath(path)
    const stat = this.stat(path)
    if (!stat)
      return
    if (stat.isDirectory()) {
      for (const name of readdirSync(path))
        this.remove(join(path, name))
      this.assertPath(path)
      rmdirSync(path)
    }
    else if (stat.isFile()) {
      unlinkSync(path)
    }
    else {
      throw new ConversationPurgeError('CONVERSATION_FILE_BOUNDARY')
    }
  }

  private assertPath(path: string): void {
    const root = this.paths.root
    if (!isPurgeDescendant(root, path) || realpathSync(root) !== root || lstatSync(root).isSymbolicLink())
      throw new ConversationPurgeError('CONVERSATION_FILE_BOUNDARY')
    let current = root
    for (const segment of relative(root, resolve(path)).split(sep)) {
      current = join(current, segment)
      const stat = this.stat(current)
      if (!stat)
        return
      if (stat.isSymbolicLink())
        throw new ConversationPurgeError('CONVERSATION_FILE_BOUNDARY')
    }
  }

  private stat(path: string) {
    try {
      return lstatSync(path)
    }
    catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
        return null
      throw error
    }
  }
}
