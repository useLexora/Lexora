import type { DatabaseSync } from 'node:sqlite'
import { mkdir, mkdtemp, realpath, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { prepareTestTurnRequest } from '../../storage/__tests__/composerDraftTestFixture'
import { MIGRATION_TEST_TIMEOUT, openMigrationFixtureDatabase } from '../../storage/__tests__/migrationFixture'
import { openBuddyDatabase } from '../../storage/database'
import { BUDDY_V1_INITIAL_SCHEMA_SQL } from '../../storage/migrations/v1Initial'
import { BUDDY_V2_CHANGE_SCHEMA_SQL } from '../../storage/migrations/v2Change'
import { BUDDY_V3_SPACE_SCHEMA_SQL } from '../../storage/migrations/v3Space'
import { createRunRepository } from '../../storage/runRepository'
import { createSpaceRepository } from '../../storage/spaceRepository'
import { SpaceService } from '../SpaceService'

const databases: DatabaseSync[] = []
const directories: string[] = []

afterEach(async () => {
  for (const database of databases.splice(0))
    database.close()
  await Promise.all(directories.splice(0).map(directory => (
    rm(directory, { force: true, recursive: true })
  )))
})

describe('spaceService', () => {
  it('creates independent Spaces that bind the same real directory', async () => {
    const fixture = await createFixture()

    const first = await fixture.service.create(spaceInput('First', fixture.directory))
    const second = await fixture.service.create({
      ...spaceInput('Second', fixture.directory),
      memoryScope: 'space_only',
    })

    expect(second.id).not.toBe(first.id)
    expect(first.primaryDirectory?.resourcesTrustedAt).toBe(first.createdAt)
    expect(first).toMatchObject({ icon: 'folder', iconColor: 'default' })
    expect(fixture.service.list()).toMatchObject([
      {
        memoryScope: 'personal_and_space',
        name: 'First',
        primaryDirectory: { canonicalRoot: fixture.directory },
      },
      {
        memoryScope: 'space_only',
        name: 'Second',
        primaryDirectory: { canonicalRoot: fixture.directory },
      },
    ])
  })

  it('blocks directory changes and deletion during active runs while allowing metadata updates', async () => {
    const fixture = await createFixture()
    const nextDirectory = join(fixture.root, 'next-workspace')
    await mkdir(nextDirectory)
    const space = await fixture.service.create(spaceInput('Running', fixture.directory))
    seedTurn(fixture.database, space.id)

    expect(fixture.service.list()[0]?.activeRunCount).toBe(1)
    await expect(fixture.service.delete(space.id))
      .rejects
      .toMatchObject({ code: 'SPACE_HAS_ACTIVE_RUNS' })
    await expect(fixture.service.update({
      memoryScope: 'personal_and_space',
      name: 'Running',
      primaryDirectory: { id: null, root: nextDirectory },
      primaryDirectorySelectionVerified: true,
      spaceId: space.id,
    })).rejects.toMatchObject({ code: 'SPACE_HAS_ACTIVE_RUNS' })
    const update = {
      memoryScope: 'space_only' as const,
      name: 'Renamed while running',
      primaryDirectory: {
        id: space.primaryDirectory!.id,
        root: space.primaryDirectory!.root,
      },
      primaryDirectorySelectionVerified: false,
      spaceId: space.id,
    }
    const appearance = { icon: 'star-filled' as const, iconColor: 'blue-bright' as const }
    await expect(fixture.service.update({ ...update, ...appearance })).resolves.toMatchObject({
      ...appearance,
      memoryScope: 'space_only',
      name: 'Renamed while running',
      primaryDirectory: space.primaryDirectory,
    })
    await expect(fixture.service.update(update)).resolves.toMatchObject(appearance)
  })

  it('revokes a Space without deleting its external directory or conversation history', async () => {
    const fixture = await createFixture()
    const space = await fixture.service.create(spaceInput('Completed', fixture.directory))
    seedTurn(fixture.database, space.id)
    const runs = createRunRepository(fixture.database)
    runs.markRunning('run-1', '2026-08-19T00:00:01.000Z')
    runs.reconcileTerminal('run-1', 'completed', '2026-08-19T00:00:02.000Z', null)

    await fixture.service.delete(space.id)

    await expect(stat(fixture.directory)).resolves.toMatchObject({})
    expect(fixture.database.prepare(`
      SELECT COUNT(*) AS count FROM conversations WHERE space_id = ?
    `).get(space.id)).toEqual({ count: 1 })
    expect(fixture.service.list()).toMatchObject([{
      name: 'Completed',
      primaryDirectory: null,
      revokedAt: expect.any(String),
    }])
  })

  it('replaces covered additional grants when a broader directory is authorized', async () => {
    const fixture = await createFixture()
    const externalRoot = join(fixture.root, 'external')
    const memoryRoot = join(externalRoot, 'data', 'memory')
    await mkdir(memoryRoot, { recursive: true })
    const appearance = { icon: 'heart-filled' as const, iconColor: 'red-deep' as const }
    const space = await fixture.service.create({ ...spaceInput('Space', fixture.directory), ...appearance })

    const first = await fixture.service.grantAdditionalDirectory({
      root: memoryRoot,
      spaceId: space.id,
    })
    const expanded = await fixture.service.grantAdditionalDirectory({
      root: externalRoot,
      spaceId: space.id,
    })

    expect(expanded).toMatchObject({
      changed: true,
      coveredGrantIds: [first.grant.id],
      grant: { canonicalRoot: externalRoot },
    })
    expect(fixture.service.list()[0]).toMatchObject({
      ...appearance,
      additionalDirectories: [{ canonicalRoot: externalRoot, id: expanded.grant.id }],
    })
    expect(fixture.database.prepare(`
      SELECT revoked_at FROM space_directory_bindings WHERE id = ?
    `).get(first.grant.id)).toMatchObject({ revoked_at: expect.any(String) })
    const event = fixture.database.prepare(`
      SELECT payload_json FROM space_events
      WHERE space_id = ? AND json_extract(payload_json, '$.authorization.root') = ?
    `).get(space.id, externalRoot) as { payload_json: string }
    expect(JSON.parse(event.payload_json)).toMatchObject({
      authorization: {
        coveredGrantIds: [first.grant.id],
        root: externalRoot,
      },
    })
    await expect(fixture.service.grantAdditionalDirectory({ root: memoryRoot, spaceId: space.id }))
      .resolves
      .toMatchObject({ changed: false, grant: { id: expanded.grant.id } })
  })

  it('creates an approved additional directory that does not exist yet', async () => {
    const fixture = await createFixture()
    const approvedRoot = join(fixture.root, 'new', 'output')
    const space = await fixture.service.create(spaceInput('Space', fixture.directory))

    await expect(fixture.service.grantAdditionalDirectory({
      root: approvedRoot,
      spaceId: space.id,
    })).resolves.toMatchObject({
      changed: true,
      grant: { canonicalRoot: approvedRoot, root: approvedRoot },
    })
    await expect(stat(approvedRoot)).resolves.toMatchObject({})
  })

  it('keeps concurrent directory grants after asynchronous path resolution', async () => {
    const fixture = await createFixture()
    const firstRoot = join(fixture.root, 'external-a')
    const secondRoot = join(fixture.root, 'external-b')
    await Promise.all([mkdir(firstRoot), mkdir(secondRoot)])
    const space = await fixture.service.create(spaceInput('Space', fixture.directory))

    const grants = await Promise.all([
      fixture.service.grantAdditionalDirectory({ root: firstRoot, spaceId: space.id }),
      fixture.service.grantAdditionalDirectory({ root: secondRoot, spaceId: space.id }),
    ])

    expect(grants.every(grant => grant.changed)).toBe(true)
    expect(fixture.service.list()[0]?.additionalDirectories.map(
      directory => directory.canonicalRoot,
    ).sort()).toEqual([firstRoot, secondRoot].sort())
  })

  it('trusts an existing primary directory while removing space instructions', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'lexora-buddy-space-migration-'))
    directories.push(directory)
    const databasePath = join(directory, 'buddy.sqlite3')
    const legacy = openMigrationFixtureDatabase(databasePath)
    legacy.exec(BUDDY_V1_INITIAL_SCHEMA_SQL)
    legacy.exec(BUDDY_V2_CHANGE_SCHEMA_SQL)
    legacy.exec(BUDDY_V3_SPACE_SCHEMA_SQL)
    legacy.exec(`
      INSERT INTO spaces (
        id, name, memory_scope, instructions, revoked_at, created_at, updated_at
      ) VALUES (
        'space-1', 'Writing', 'personal_and_project', 'Remove me', NULL,
        '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z'
      );
      INSERT INTO space_directory_bindings (
        id, space_id, root, canonical_root, access_granted_at,
        resources_trusted_at, is_primary, revision, revoked_at, created_at, updated_at
      ) VALUES (
        'directory-1', 'space-1', '/workspace', '/workspace',
        '2026-09-01T00:00:00.000Z', NULL, 1, 1, NULL,
        '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z'
      );
    `)
    legacy.exec('PRAGMA user_version = 3')
    legacy.close()

    const migrated = openBuddyDatabase({ databasePath })
    databases.push(migrated)
    const binding = migrated.prepare(`
      SELECT resources_trusted_at FROM space_directory_bindings
      WHERE space_id = 'space-1' AND is_primary = 1
    `).get() as { resources_trusted_at: string | null }

    expect(binding.resources_trusted_at).toBe('2026-09-01T00:00:00.000Z')
  }, MIGRATION_TEST_TIMEOUT)
})

async function createFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'lexora-buddy-spaces-')))
  directories.push(root)
  const directory = join(root, 'workspace')
  await mkdir(directory)
  const database = openBuddyDatabase({ databasePath: ':memory:' })
  databases.push(database)
  return {
    database,
    directory,
    root,
    service: new SpaceService(createSpaceRepository(database)),
  }
}

function spaceInput(name: string, root: string) {
  return {
    memoryScope: 'personal_and_space' as const,
    name,
    primaryDirectory: { id: null, root },
    primaryDirectorySelectionVerified: true,
  }
}

function seedTurn(database: DatabaseSync, spaceId: string): void {
  prepareTestTurnRequest(database, {
    attachmentBindings: [],
    branchId: 'branch-1',
    conversationId: 'conversation-1',
    createdAt: '2026-08-19T00:00:00.000Z',
    approvalPolicy: 'policy' as const,
    executionProfile: 'workspace_write',
    model: 'model-1',
    provider: 'provider-1',
    requestFingerprint: 'fingerprint-1',
    requestId: 'request-1',
    runId: 'run-1',
    runInput: {
      attachmentIds: [],
      contextItems: [],
      prompt: 'hello',
      reasoning: null,
      serviceTier: null,
    },
    spaceId,
    title: 'Conversation',
    userMessageContent: { text: 'hello' },
    userMessageId: 'message-1',
  })
}
