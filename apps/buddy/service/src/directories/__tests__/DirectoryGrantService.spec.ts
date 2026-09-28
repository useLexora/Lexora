import type { DatabaseSync } from 'node:sqlite'
import { mkdir, mkdtemp, realpath, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { createConversationDirectoryGrantRepository } from '../../storage/conversationDirectoryGrantRepository'
import { createConversationRepository } from '../../storage/conversationRepository'
import { openBuddyDatabase } from '../../storage/database'
import { DirectoryGrantService } from '../DirectoryGrantService'

const timestamp = '2026-09-03T00:00:00.000Z'

const databases: DatabaseSync[] = []
const roots: string[] = []

afterEach(async () => {
  for (const database of databases.splice(0))
    database.close()
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

describe('directoryGrantService', () => {
  it('keeps persistence distinct from active-session application after a revocation', async () => {
    const fixture = await createFixture()
    const events: unknown[] = []
    fixture.service.onDidCommit((event) => {
      events.push(event)
      fixture.repository.revokeAll(event.conversationId, timestamp)
    })
    const owner = { id: 'conversation-1', kind: 'conversation' as const }
    const result = await fixture.service.grant({ owner, root: fixture.child })
    expect(result.changed).toBe(true)
    expect(events).toMatchObject([{ conversationId: owner.id, grantId: result.grant.id, revision: 1 }])
    expect(() => fixture.service.assertCurrent(owner, result.grant.id)).toThrow()
    expect(fixture.repository.listActive(owner.id)).toEqual([])
    expect(JSON.stringify(events)).not.toContain(fixture.child)
  })

  it('checks the owner in the transaction after asynchronous directory validation', async () => {
    const fixture = await createFixture()
    const events: unknown[] = []
    fixture.service.onDidCommit(event => events.push(event))
    const pending = fixture.service.grant({ owner: { kind: 'conversation', id: 'conversation-1' }, root: fixture.child })
    fixture.database.prepare('UPDATE conversations SET deleted_at = ? WHERE id = ?').run(timestamp, 'conversation-1')
    await expect(pending).rejects.toThrow()
    expect(fixture.repository.listActive('conversation-1')).toEqual([])
    expect(events).toEqual([])
  })

  it('persists a conversation grant and reuses a covering grant', async () => {
    const fixture = await createFixture()
    const granted = await fixture.service.grant({
      owner: { id: 'conversation-1', kind: 'conversation' },
      root: fixture.child,
    })

    expect(granted).toMatchObject({
      changed: true,
      coveredGrantIds: [],
      grant: { canonicalRoot: fixture.child, root: fixture.child },
    })
    await expect(fixture.service.grant({
      owner: { id: 'conversation-1', kind: 'conversation' },
      root: join(fixture.child, 'nested'),
    })).resolves.toMatchObject({
      changed: false,
      coveredGrantIds: [],
      grant: { id: granted.grant.id },
    })
    expect(fixture.repository.listActive('conversation-1')).toHaveLength(1)
  })

  it('creates and persists an approved directory that does not exist yet', async () => {
    const fixture = await createFixture()
    const approvedRoot = join(fixture.child, 'new', 'output')

    await expect(fixture.service.grant({
      owner: { id: 'conversation-1', kind: 'conversation' },
      root: approvedRoot,
    })).resolves.toMatchObject({
      changed: true,
      grant: { canonicalRoot: approvedRoot, root: approvedRoot },
    })
    expect(fixture.repository.listActive('conversation-1')).toEqual([
      expect.objectContaining({ canonicalRoot: approvedRoot, root: approvedRoot }),
    ])
  })

  it('replaces narrower grants when a broader directory is approved', async () => {
    const fixture = await createFixture()
    const narrow = await fixture.service.grant({
      owner: { id: 'conversation-1', kind: 'conversation' },
      root: fixture.child,
    })
    const broad = await fixture.service.grant({
      owner: { id: 'conversation-1', kind: 'conversation' },
      root: fixture.root,
    })

    expect(broad).toMatchObject({
      changed: true,
      coveredGrantIds: [narrow.grant.id],
      grant: { canonicalRoot: fixture.root },
    })
    expect(fixture.repository.listActive('conversation-1')).toEqual([
      expect.objectContaining({ id: broad.grant.id }),
    ])
  })

  it('does not attach conversation grants to a Space conversation', async () => {
    const fixture = await createFixture({ spaceId: 'space-1' })
    const unauthorizedRoot = join(fixture.root, 'unauthorized')

    await expect(fixture.service.grant({
      owner: { id: 'conversation-1', kind: 'conversation' },
      root: unauthorizedRoot,
    })).rejects.toMatchObject({ code: 'DIRECTORY_GRANT_OWNER_INVALID' })
    await expect(stat(unauthorizedRoot)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

async function createFixture(options: { spaceId?: string } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'lexora-grant-')))
  roots.push(root)
  const child = join(root, 'child')
  await mkdir(join(child, 'nested'), { recursive: true })
  const database = openBuddyDatabase({ databasePath: ':memory:' })
  databases.push(database)
  if (options.spaceId) {
    database.prepare(`
      INSERT INTO spaces (
        id, name, memory_scope, revoked_at, created_at, updated_at
      ) VALUES (?, 'Space', 'personal_and_space', NULL, ?, ?)
    `).run(options.spaceId, timestamp, timestamp)
  }
  database.prepare(`
    INSERT INTO conversations (
      id, space_id, title, active_branch_id, created_at, updated_at
    ) VALUES ('conversation-1', ?, NULL, NULL, ?, ?)
  `).run(options.spaceId ?? null, timestamp, timestamp)
  const repository = createConversationDirectoryGrantRepository(database)
  const conversations = createConversationRepository(database)
  const service = new DirectoryGrantService({
    conversationGrants: repository,
    conversations,
    spaces: {
      isGrantCurrent: () => false,
      grantAdditionalDirectory: async () => {
        throw new Error('Space grant was not expected')
      },
    },
  })
  return { child, database, repository, root, service }
}
