import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ArtifactService } from '../../artifacts/ArtifactService'
import { createLocalCommandPrincipal } from '../../commands/CommandAdmissionService'
import { ProductQueries } from '../../productProtocol/ProductQueries'
import { seedSqliteRun } from '../../storage/__tests__/sqliteRunFixture'
import { createArtifactRepository } from '../../storage/artifactRepository'
import { createAttachmentPersistenceRepository } from '../../storage/attachmentPersistenceRepository'
import { BuddyDataPaths } from '../../storage/BuddyDataPaths'
import { openBuddyMigrationCandidate } from '../../storage/database'
import { RemoteResourceService } from '../RemoteResourceService'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'lexora-resources-'))
  const database = openBuddyMigrationCandidate({ databasePath: join(root, 'buddy.sqlite3') })
  database.exec('UPDATE storage_profile SET authority = \'sqlite\', migration_state = \'ready\'')
  seedSqliteRun(database, 'run')
  const local = createLocalCommandPrincipal(database)
  let active = true
  const principal = { actorId: local.actorId, assertAuthenticated: () => {
    if (!active)
      throw new Error('REVOKED')
    local.assertAuthenticated()
  } }
  const paths = new BuddyDataPaths(root)
  const workspace = paths.conversationWorkspace('task-1')
  await mkdir(workspace, { recursive: true })
  const source = join(workspace, 'result.txt')
  await writeFile(source, 'original bytes')
  const artifacts = createArtifactRepository(database)
  artifacts.save({ id: 'artifact', conversationId: 'task-1', currentPath: source, directoryRoot: workspace, directoryGrantId: 'task-1', relativePath: 'result.txt', kind: 'file', name: 'result.txt', mimeType: 'text/plain', sizeBytes: 14, sourceArtifactId: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
  const artifactService = new ArtifactService({ repository: artifacts })
  const views = (actor: string) => new ProductQueries(database, actor, 'instance').views
  const service = new RemoteResourceService({ database, root, instanceId: 'instance', views, artifacts: artifactService })
  const prepare = (id = 'artifact:artifact') => service.prepare({ resourceId: id, expectedVersion: views(local.actorId).resource(id)!.revision }, principal)
  const server = createServer((request, response) => {
    void service.bytes(request, response, principal).catch((error) => {
      if (response.headersSent) {
        response.destroy()
      }
      else {
        response.statusCode = 409
        response.end(JSON.stringify({ error: error.code ?? error.message }))
      }
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const get = (resource: { downloadId: string, contentVersion: string }, headers: Record<string, string> = {}) => fetch(`${endpoint}/v1/resources/${resource.downloadId}`, { headers: { 'If-Match': `"${resource.contentVersion}"`, ...headers } })
  cleanups.push(async () => {
    server.closeAllConnections()
    await service.close()
    await artifactService.dispose()
    await new Promise<void>(resolve => server.close(() => resolve()))
    database.close()
    await rm(root, { recursive: true, force: true })
  })
  return { database, root, source, service, prepare, get, revoke: () => active = false }
}

describe('immutable authorized resource downloads', () => {
  it('exports a registered artifact as fixed bytes and rejects mixed versions and ranges', async () => {
    const f = await fixture()
    const resource = await f.prepare()
    expect(JSON.stringify(resource)).not.toContain(f.source)
    expect(resource.contentVersion).toBe(createHash('sha256').update('original bytes').digest('hex'))
    await writeFile(f.source, 'newer content!')
    const partial = await f.get(resource, { Range: 'bytes=0-7' })
    expect(partial.status).toBe(206)
    expect(partial.headers.get('content-range')).toBe('bytes 0-7/14')
    expect(await partial.text()).toBe('original')
    const rest = await f.get(resource, { Range: 'bytes=8-' })
    expect(await rest.text()).toBe(' bytes')
    expect((await f.get(resource, { 'If-Match': '"wrong"' })).status).toBe(409)
    expect((await f.get(resource, { Range: 'bytes=0-2,5-8' })).status).toBe(409)
    expect((await f.get(resource, { Range: 'bytes=14-' })).status).toBe(409)
    const changed = await f.prepare()
    expect(changed.contentVersion).not.toBe(resource.contentVersion)
  })

  it('does not export a substituted symlink outside the authorized workspace', async () => {
    const f = await fixture()
    const outside = join(f.root, 'outside.txt')
    await writeFile(outside, 'unpublished bytes')
    await rm(f.source)
    await symlink(outside, f.source)
    await expect(f.prepare()).rejects.toThrow()
    expect(f.database.prepare('SELECT COUNT(*) AS n FROM remote_exports').get()!.n).toBe(0)
  })

  it('protects a fixed export from GC and releases it after expiry without deleting its source', async () => {
    const f = await fixture()
    const resource = await f.prepare()
    const files = createAttachmentPersistenceRepository(f.database)
    expect(files.candidates()).toEqual([])
    f.database.prepare('UPDATE private_network_state SET last_observed_ms = ?').run(Date.parse(resource.expiresAt) + 1)
    f.service.sweep()
    expect(files.candidates()).toHaveLength(1)
    expect((await f.get(resource)).status).toBe(409)
    expect(await readFile(f.source, 'utf8')).toBe('original bytes')
  })

  it('checks current object visibility and authorization again before each download', async () => {
    const f = await fixture()
    const resource = await f.prepare()
    f.database.prepare('UPDATE conversations SET deleted_at = ? WHERE id = ?').run(new Date().toISOString(), 'task-1')
    expect((await f.get(resource)).status).toBe(409)
    f.database.prepare('UPDATE conversations SET deleted_at = NULL WHERE id = ?').run('task-1')
    f.revoke()
    expect((await f.get(resource)).status).toBe(409)
  })

  it('detects corruption of fixed bytes before it emits a successful response', async () => {
    const f = await fixture()
    const resource = await f.prepare()
    const path = String(f.database.prepare('SELECT f.path FROM remote_exports e JOIN managed_files f ON f.id = e.file_id').get()!.path)
    await writeFile(path, Buffer.from('tampered bytes'))
    const response = await f.get(resource)
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ error: 'VERSION_CHANGED' })
    expect(f.database.prepare('SELECT state FROM managed_files WHERE path = ?').get(path)!.state).toBe('unavailable')
  })
})
