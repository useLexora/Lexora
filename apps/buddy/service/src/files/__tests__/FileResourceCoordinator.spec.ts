import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it } from 'vitest'
import { FileResourceCoordinator } from '../FileResourceCoordinator'
import { NativeFileEngine } from '../NativeFileEngine'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse())
    await dispose()
})

it('reconciles overlapping and offline hazards without acquiring write rights, including after restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'file-resource-recovery-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const workspace = join(root, 'workspace')
  const journal = join(root, 'journal')
  await mkdir(workspace)
  const original = new NativeFileEngine(journal)
  await original.ready()
  await original.register('workspace', workspace)
  const record = await original.mutate({ operationId: randomUUID(), root: 'workspace', path: 'note.txt', action: { kind: 'write', text: 'original' } })
  await original.dispose()
  const db = new DatabaseSync(join(journal, 'operations.sqlite'))
  record.status = 'executing'
  db.prepare('UPDATE operations SET record=?,status=? WHERE id=?').run(JSON.stringify(record), JSON.stringify(record.status), record.operationId)
  db.close()
  const engine = new NativeFileEngine(journal)
  cleanup.push(() => engine.dispose())
  await engine.ready()
  const invocationId = randomUUID()
  const missingId = randomUUID()
  const emptyId = randomUUID()
  const orphanId = randomUUID()
  const releasedId = randomUUID()
  const hazards = [
    { invocationId, claims: [{ kind: 'file' as const, canonicalPath: join(workspace, 'note.txt') }] },
    { invocationId: missingId, claims: [{ kind: 'tree' as const, canonicalPath: join(root, 'missing', 'tree') }] },
    { invocationId: emptyId, claims: [] },
  ]
  await engine.protect(orphanId, [{ path: join(root, 'orphan'), subtree: true }])
  await engine.protect(releasedId, [{ path: join(root, 'released'), subtree: true }])
  const resources = new FileResourceCoordinator(engine)
  await resources.reconcile(hazards, id => id === releasedId)
  expect(new Set(await engine.leases())).toEqual(new Set([orphanId, invocationId, missingId, emptyId]))
  await expect(resources.write(invocationId, join(workspace, 'note.txt'), 'unsafe')).rejects.toThrow('FILE_LEASE_INVALID')
  await engine.dispose()
  const restarted = new NativeFileEngine(journal)
  cleanup.push(() => restarted.dispose())
  await restarted.ready()
  await new FileResourceCoordinator(restarted).reconcile(hazards, () => false)
  expect(new Set(await restarted.leases())).toEqual(new Set([orphanId, invocationId, missingId, emptyId]))
  expect((await restarted.query(record.operationId))?.status).toBe('needs-recovery')
  expect(await readFile(join(workspace, 'note.txt'), 'utf8')).toBe('original')
})
