import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ArtifactService } from '../../../artifacts/ArtifactService'
import { MIGRATION_TEST_TIMEOUT, openMigrationFixtureDatabase } from '../../../storage/__tests__/migrationFixture'
import { createArtifactRepository } from '../../../storage/artifactRepository'
import { createConnectorRepository } from '../../../storage/connectorRepository'
import { openBuddyDatabase } from '../../../storage/database'
import { BUDDY_SCHEMA_MIGRATIONS, BUDDY_SCHEMA_VERSION } from '../../../storage/schema'
import { createMcpResultWriter } from '../McpResultStore'

const record = { id: 'existing', name: 'Existing connector', transport: 'stdio' as const, command: 'node', args: ['server.mjs'], cwd: null, url: null, credentialRef: 'existing-secret-ref', enabled: true, executionConfirmedAt: '2026-08-01T00:00:00Z', createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-08-01T00:00:00Z' }

describe('mCP persisted data', () => {
  it('upgrades a version 17 database while retaining connector identity, execution confirmation and secret reference', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'buddy-mcp-upgrade-'))
    const path = join(directory, 'buddy.sqlite3')
    const previous = openMigrationFixtureDatabase(path)
    try {
      for (const migration of BUDDY_SCHEMA_MIGRATIONS.filter(migration => migration.version <= 17))
        previous.exec(migration.sql)
      previous.prepare('INSERT INTO mcp_servers (id, name, transport, command, args_json, cwd, url, credential_ref, trusted_at, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(record.id, record.name, record.transport, record.command, JSON.stringify(record.args), record.cwd, record.url, record.credentialRef, record.executionConfirmedAt, 1, record.createdAt, record.updatedAt)
      previous.exec('PRAGMA user_version = 17')
    }
    finally { previous.close() }
    const upgraded = openBuddyDatabase({ databasePath: path })
    try {
      const repository = createConnectorRepository(upgraded)
      expect(repository.findById(record.id)).toEqual(record)
      expect(repository.readCatalog(record.id)).toBeNull()
      expect(upgraded.prepare('PRAGMA user_version').get()).toEqual({ user_version: BUDDY_SCHEMA_VERSION })
    }
    finally {
      upgraded.close()
      await rm(directory, { recursive: true, force: true })
    }
  }, MIGRATION_TEST_TIMEOUT)

  it('publishes distinct result files and registers resolvable conversation artifacts', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'buddy-mcp-output-'))
    const database = openBuddyDatabase({ databasePath: ':memory:' })
    database.prepare('INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)').run('conversation', 'Fixture', record.createdAt, record.updatedAt)
    const service = new ArtifactService({ repository: createArtifactRepository(database) })
    const write = createMcpResultWriter({ artifactService: service, conversationId: 'conversation', cwd, grants: [{ root: cwd, canonicalRoot: cwd, grantId: 'workspace', kind: 'workspace' }] })
    try {
      const first = await write(new TextEncoder().encode('original result'), 'text/plain')
      const second = await write(new TextEncoder().encode('next result'), 'text/plain')
      expect(first.path).not.toBe(second.path)
      expect(await readFile(first.path, 'utf8')).toBe('original result')
      expect(await readFile(second.path, 'utf8')).toBe('next result')
      expect(service.resolveConversationArtifactLocation('conversation', first.artifactId).canonicalPath).toBe(first.path)
      expect(service.listConversationArtifacts('conversation')).toHaveLength(2)
    }
    finally {
      database.close()
      await rm(cwd, { recursive: true, force: true })
    }
  })
})
