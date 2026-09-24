import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { afterEach, expect, it } from 'vitest'
import { captureChangeFile } from '../captureChangeFile'
import { captureWorkspaceSnapshot } from '../workspaceSnapshot'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'buddy-snapshot-'))
  roots.push(root)
  return { root, grants: [{ canonicalRoot: root, root, grantId: 'workspace', kind: 'workspace' as const }] }
}

it('hashes large files without retaining previews and enforces exact byte limits', async () => {
  const { root } = await fixture()
  const path = join(root, 'large.txt')
  const bytes = Buffer.alloc(2 * 1024 * 1024, 65)
  await writeFile(path, bytes)
  expect(await captureChangeFile(path, 'large.txt', bytes.length)).toEqual({
    hash: createHash('sha256').update(bytes).digest('hex'),
    kind: 'oversized',
    redacted: false,
    sizeBytes: bytes.length,
    snapshotText: null,
  })
  expect(await captureChangeFile(path, 'large.txt', bytes.length - 1)).toMatchObject({ hash: null, snapshotText: null })
})

it('keeps sensitive files hash-only, skips ignored directories and deduplicates overlapping grants', async () => {
  const { root, grants } = await fixture()
  const nested = join(root, 'nested')
  await mkdir(nested)
  await mkdir(join(root, 'node_modules'))
  await writeFile(join(root, 'node_modules', 'ignored.txt'), 'ignored')
  await writeFile(join(root, '.env'), 'EXAMPLE_TOKEN=fixture-only')
  await writeFile(join(root, '.env.dev.example'), 'PORT=3000')
  await writeFile(join(nested, 'text.txt'), 'hello')
  const result = await captureWorkspaceSnapshot([...grants, { ...grants[0]!, canonicalRoot: nested, root: nested, grantId: 'nested' }], root)
  expect(result.complete).toBe(true)
  expect(result.files.size).toBe(3)
  expect([...result.files.values()].find(file => file.relativePath === '.env')).toMatchObject({ kind: 'sensitive', snapshotText: null })
  expect([...result.files.values()].find(file => file.relativePath === '.env.dev.example')).toMatchObject({ snapshotText: 'PORT=3000' })
  expect([...result.files.values()].find(file => file.relativePath === 'nested/text.txt')).toMatchObject({ directoryGrantId: 'nested', snapshotText: 'hello' })
})

it.runIf(process.platform === 'linux')('refuses symlink files and does not follow linked directories', async () => {
  const { root, grants } = await fixture()
  await writeFile(join(root, 'text.txt'), 'text')
  await symlink(join(root, 'text.txt'), join(root, 'link.txt'))
  await symlink(root, join(root, 'cycle'))
  await expect(captureChangeFile(join(root, 'link.txt'), 'link.txt')).rejects.toThrow()
  const snapshot = await captureWorkspaceSnapshot(grants, root)
  expect(snapshot.complete).toBe(true)
  expect(snapshot.files.size).toBe(1)
})
