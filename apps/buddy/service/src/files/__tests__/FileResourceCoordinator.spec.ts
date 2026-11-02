import type { FilePublication } from '../FileResourceCoordinator'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { chmod, link, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it, vi } from 'vitest'
import { MutationCoordinator } from '../../changes/MutationCoordinator'
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
  const restoredResources = new FileResourceCoordinator(restarted)
  await restoredResources.reconcile(hazards, () => false)
  expect(new Set(await restarted.leases())).toEqual(new Set([orphanId, invocationId, missingId, emptyId]))
  expect((await restarted.query(record.operationId))?.status).toBe('needs-recovery')
  expect(await readFile(join(workspace, 'note.txt'), 'utf8')).toBe('original')
  await expect(restoredResources.write(invocationId, join(workspace, 'note.txt'), 'not-authorized')).rejects.toThrow('FILE_LEASE_INVALID')
  const next = randomUUID()
  await restoredResources.acquire(next, hazards[0]!.claims, 'runtime')
  await restoredResources.write(next, join(workspace, 'note.txt'), 'new-operation')
  await restoredResources.release(next)
  expect(await readFile(join(workspace, 'note.txt'), 'utf8')).toBe('new-operation')
  expect((await restarted.query(record.operationId))?.status).toBe('needs-recovery')
  expect(new Set(await restarted.leases())).toEqual(new Set([orphanId, invocationId, missingId, emptyId]))
})

it.each(['target', 'parent', 'new-parent'] as const)('rejects a %s symlink swap during native binary publication without touching the outside file', async (swap) => {
  const f = await binaryFixture()
  const output = join(f.workspace, 'images')
  const target = join(output, 'result.png')
  const outside = join(f.root, 'outside')
  await mkdir(outside)
  await writeFile(join(outside, 'result.png'), 'outside-preserved')
  if (swap !== 'new-parent') {
    await mkdir(output)
    await writeFile(target, 'before')
  }
  let swapped = false
  await expect(f.publish({ path: target, bytes: Uint8Array.of(0, 1, 2), size: 3, overwrite: true, assertCurrent: async () => {
    if (swapped)
      return
    swapped = true
    if (swap === 'target') {
      await rm(target)
      await symlink(join(outside, 'result.png'), target)
    }
    else {
      if (swap === 'parent')
        await rename(output, join(f.workspace, 'retired-images'))
      await symlink(outside, output, 'junction')
    }
  } })).rejects.toThrow()
  expect(await readFile(join(outside, 'result.png'), 'utf8')).toBe('outside-preserved')
  if (swap === 'parent')
    expect(await readFile(join(f.workspace, 'retired-images', 'result.png'), 'utf8')).toBe('before')
  await f.assertSettled()
})

it('rejects a concurrent overwrite after reading the binary version and preserves the other writer', async () => {
  const f = await binaryFixture()
  const path = join(f.workspace, 'shared.png')
  await writeFile(path, Uint8Array.of(0, 1, 2))
  await expect(f.publish({ path, bytes: (async function* () {
    yield Uint8Array.of(3)
    await writeFile(path, Uint8Array.of(6, 7, 8))
    yield Uint8Array.of(4, 5)
  })(), size: 3, overwrite: true })).rejects.toThrow('FILE_CONFLICT')
  expect(await readFile(path)).toEqual(Buffer.from([6, 7, 8]))
  await f.assertSettled()
})

it('creates missing output directories safely and preserves create-only and overwrite semantics', async () => {
  const f = await binaryFixture()
  const path = join(f.workspace, 'outputs', 'nested', 'file.bin')
  await f.publish({ path, bytes: Uint8Array.of(0, 1, 2), size: 3 })
  if (process.platform !== 'win32') {
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect((await stat(join(f.workspace, 'outputs'))).mode & 0o777).toBe(0o700)
    expect((await stat(join(f.workspace, 'outputs', 'nested'))).mode & 0o777).toBe(0o700)
    await chmod(path, 0o640)
  }
  await expect(f.publish({ path, bytes: Uint8Array.of(3), size: 1 })).rejects.toThrow('FILE_CONFLICT')
  expect(await readFile(path)).toEqual(Buffer.from([0, 1, 2]))
  await f.publish({ path, bytes: Uint8Array.of(3, 4), size: 2, overwrite: true })
  expect(await readFile(path)).toEqual(Buffer.from([3, 4]))
  if (process.platform !== 'win32')
    expect((await stat(path)).mode & 0o777).toBe(0o640)
  await f.assertSettled()
})

it.each(['cancelled', 'short', 'oversized'] as const)('cleans %s staged streams without publishing partial bytes', async (failure) => {
  const f = await binaryFixture()
  const path = join(f.workspace, 'stream.bin')
  const controller = new AbortController()
  await expect(f.publish({ path, size: 2, bytes: (async function* () {
    yield Uint8Array.of(1)
    if (failure === 'cancelled')
      controller.abort()
    if (failure !== 'short')
      yield failure === 'oversized' ? Uint8Array.of(2, 3) : Uint8Array.of(2)
  })() }, controller.signal)).rejects.toThrow()
  await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
  await f.assertSettled()
})

it.each(['path', 'hardlink'] as const)('removes staging for a cancelled %s waiter and never publishes after the blocker releases', async (kind) => {
  const f = await binaryFixture()
  const path = join(f.workspace, 'waiting.bin')
  await writeFile(path, 'preserved')
  const held = await f.mutations.acquire({ runId: 'holder', invocationId: randomUUID(), lifetime: 'runtime', claims: [{ kind: 'file', canonicalPath: path }], signal: new AbortController().signal })
  const controller = new AbortController()
  const target = kind === 'hardlink' ? join(f.workspace, 'alias.bin') : path
  if (kind === 'hardlink')
    await link(path, target)
  const nativeWaiting = Promise.withResolvers<void>()
  const acquire = f.engine.acquire.bind(f.engine)
  const nativeGate = kind === 'hardlink'
    ? vi.spyOn(f.engine, 'acquire').mockImplementation(async (...args) => {
        const pending = acquire(...args)
        await f.engine.leases()
        nativeWaiting.resolve()
        return pending
      })
    : undefined
  const waiting = f.publish({ path: target, bytes: Uint8Array.of(1), size: 1, overwrite: true }, controller.signal)
  const cancelled = expect(waiting).rejects.toThrow()
  try {
    await expect.poll(() => f.mutations.getRunState('publication')).toMatchObject(kind === 'path' ? { pending: 1, active: 0 } : { pending: 0, active: 1 })
    if (kind === 'hardlink')
      await nativeWaiting.promise
    controller.abort()
    await cancelled
    expect(await readdir(join(f.journal, 'publication'))).toEqual([])
  }
  finally {
    nativeGate?.mockRestore()
    await held.release()
  }
  expect(await readFile(path, 'utf8')).toBe('preserved')
  await f.assertSettled()
})

it('keeps separate staging claims parallel and cleans both after their native writes settle', async () => {
  const f = await binaryFixture()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let count = 0
  const pending = Promise.all(['first', 'second'].map(name => f.publish({ path: join(f.workspace, `${name}.bin`), size: 1, bytes: (async function* () {
    if (++count === 2)
      entered.resolve()
    await release.promise
    yield Uint8Array.of(name === 'first' ? 1 : 2)
  })() })))
  try {
    await entered.promise
  }
  finally { release.resolve() }
  await pending
  expect(await readFile(join(f.workspace, 'first.bin'))).toEqual(Buffer.from([1]))
  expect(await readFile(join(f.workspace, 'second.bin'))).toEqual(Buffer.from([2]))
  await f.assertSettled()
})

async function binaryFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'binary-publication-')))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const workspace = join(root, 'workspace')
  await mkdir(workspace)
  const journal = join(root, 'journal')
  const engine = new NativeFileEngine(journal)
  cleanup.push(() => engine.dispose())
  const files = new FileResourceCoordinator(engine)
  const mutations = new MutationCoordinator({ resources: files })
  cleanup.push(() => mutations.dispose())
  const publish = (input: FilePublication, signal = new AbortController().signal) => files.withStagingDirectory(async (stagingDirectory) => {
    const claims = await files.fileWriteClaims([input.path])
    const lease = await mutations.acquire({ runId: 'publication', invocationId: randomUUID(), lifetime: 'runtime', claims: [...claims, { kind: 'tree', canonicalPath: stagingDirectory }], signal })
    try {
      await files.writeFile(lease.invocationId, stagingDirectory, input, signal)
    }
    finally { await lease.release() }
  })
  return { root, workspace, journal, engine, mutations, publish, async assertSettled() {
    expect(await readdir(join(journal, 'publication'))).toEqual([])
    expect(await engine.leases()).toEqual([])
    expect(mutations.getRunState('publication')).toEqual({ active: 0, pending: 0, hazards: [] })
  } }
}
