import type { GrantOwner } from '../permissions/permissionContract'
import type {
  ConversationDirectoryGrantMutation,
  ConversationDirectoryGrantRepository,
} from '../storage/conversationDirectoryGrantRepository'
import type { ConversationRepository } from '../storage/conversationRepository'
import { randomUUID } from 'node:crypto'
import { mkdir, realpath, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Emitter } from '../../../shared/events/Emitter'
import { copyEventSnapshot } from '../../../shared/events/eventSnapshot'

export interface DirectoryGrantMutation {
  changed: boolean
  coveredGrantIds: readonly string[]
  grant: {
    canonicalRoot: string
    id: string
    root: string
  }
}

export interface DirectoryGrantServiceOptions {
  conversationGrants: ConversationDirectoryGrantRepository
  conversations: Pick<ConversationRepository, 'findById'>
  spaces: {
    isGrantCurrent: (spaceId: string, grantId: string) => boolean
    grantAdditionalDirectory: (input: {
      root: string
      spaceId: string
    }) => Promise<DirectoryGrantMutation>
  }
  onListenerError?: (error: unknown) => void
}

export interface ConversationDirectoryGrantCommit {
  readonly revision: number
  readonly conversationId: string
  readonly grantId: string
  readonly revokedGrantIds: readonly string[]
}

export class DirectoryGrantService {
  readonly #conversationGrants: ConversationDirectoryGrantRepository
  readonly #conversations: DirectoryGrantServiceOptions['conversations']
  readonly #spaces: DirectoryGrantServiceOptions['spaces']
  readonly #changes: Emitter<ConversationDirectoryGrantCommit>
  readonly onDidCommit
  #revision = 0
  #disposed = false
  #quiescing = false
  readonly #pending = new Set<Promise<DirectoryGrantMutation>>()

  constructor(options: DirectoryGrantServiceOptions) {
    this.#conversationGrants = options.conversationGrants
    this.#conversations = options.conversations
    this.#spaces = options.spaces
    this.#changes = new Emitter(options.onListenerError ?? (() => console.error('DIRECTORY_GRANT_OBSERVER_FAILED')))
    this.onDidCommit = this.#changes.event
  }

  grant(input: { owner: GrantOwner, root: string }): Promise<DirectoryGrantMutation> {
    if (this.#disposed || this.#quiescing)
      return Promise.reject(new DirectoryGrantError('DIRECTORY_GRANT_OWNER_INVALID'))
    const pending = this.#grant(copyEventSnapshot(input)).finally(() => this.#pending.delete(pending))
    this.#pending.add(pending)
    return pending
  }

  async #grant(input: { owner: GrantOwner, root: string }): Promise<DirectoryGrantMutation> {
    if (input.owner.kind === 'space') {
      return this.#spaces.grantAdditionalDirectory({
        root: input.root,
        spaceId: input.owner.id,
      })
    }

    const conversation = this.#conversations.findById(input.owner.id)
    if (!conversation || conversation.deletedAt !== null || conversation.spaceId !== null)
      throw new DirectoryGrantError('DIRECTORY_GRANT_OWNER_INVALID')
    const root = await resolveDirectory(input.root)
    if (this.#disposed)
      throw new DirectoryGrantError('DIRECTORY_GRANT_OWNER_INVALID')
    const result = this.#conversationGrants.grant({
      canonicalRoot: root,
      conversationId: conversation.id,
      createdAt: new Date().toISOString(),
      id: randomUUID(),
      root,
    })
    if (result.changed)
      this.#changes.fire(copyEventSnapshot({ revision: ++this.#revision, conversationId: conversation.id, grantId: result.grant.id, revokedGrantIds: result.coveredGrantIds }))
    return copyEventSnapshot(toMutation(result))
  }

  assertCurrent(owner: GrantOwner, grantId: string): void {
    if (owner.kind === 'space') {
      if (this.#spaces.isGrantCurrent(owner.id, grantId))
        return
    }
    else {
      const conversation = this.#conversations.findById(owner.id)
      if (conversation && conversation.deletedAt === null && conversation.spaceId === null && this.#conversationGrants.listActive(owner.id).some(grant => grant.id === grantId))
        return
    }
    throw new DirectoryGrantError('DIRECTORY_GRANT_OWNER_INVALID')
  }

  async quiesce(): Promise<void> {
    this.#quiescing = true
    while (this.#pending.size)
      await Promise.allSettled([...this.#pending])
  }

  async dispose(): Promise<void> {
    await this.quiesce()
    this.#disposed = true
    this.#changes.dispose()
  }
}

async function resolveDirectory(root: string): Promise<string> {
  try {
    const requestedRoot = resolve(root)
    await mkdir(requestedRoot, { recursive: true })
    const canonicalRoot = await realpath(requestedRoot)
    if (canonicalRoot !== requestedRoot)
      throw new Error('Directory identity changed')
    if (!(await stat(canonicalRoot)).isDirectory())
      throw new Error('Not a directory')
    return canonicalRoot
  }
  catch {
    throw new DirectoryGrantError('DIRECTORY_GRANT_INVALID')
  }
}

function toMutation(result: ConversationDirectoryGrantMutation): DirectoryGrantMutation {
  return {
    changed: result.changed,
    coveredGrantIds: result.coveredGrantIds,
    grant: {
      canonicalRoot: result.grant.canonicalRoot,
      id: result.grant.id,
      root: result.grant.root,
    },
  }
}

export class DirectoryGrantError extends Error {
  readonly code: 'DIRECTORY_GRANT_INVALID' | 'DIRECTORY_GRANT_OWNER_INVALID'

  constructor(code: DirectoryGrantError['code']) {
    super('Lexora Buddy cannot grant the requested directory')
    this.name = 'DirectoryGrantError'
    this.code = code
  }
}
