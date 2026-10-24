import type { DatabaseSync } from 'node:sqlite'
import type { RuntimeRequestHandler } from '../../../../shared/runtime/rpcPeer'
import type { RuntimeRequestRegistrar } from '../../rpc/runtimeRequest'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { getActiveSpaceDirectories, spacesResponseSchemas, spaceWorkspaceDirectoryId } from '../../../../shared/spaces/spaceApi'
import { NativeFileEngine } from '../../files/NativeFileEngine'
import { openBuddyDatabase } from '../../storage/database'
import { createSpaceRepository } from '../../storage/spaceRepository'
import { registerSpaceRpc } from '../registerSpaceRpc'
import { SpaceFileService } from '../SpaceFileService'
import { SpaceService } from '../SpaceService'
import { SpaceWorkspaceDirectories } from '../SpaceWorkspaceDirectories'

const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
})

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'buddy-space-workspace-')))
  const database: DatabaseSync = openBuddyDatabase({ databasePath: ':memory:' })
  const repository = createSpaceRepository(database)
  const spaces = new SpaceService(repository)
  const workspaces = new SpaceWorkspaceDirectories(spaceId => join(root, 'spaces', spaceId, 'workspace'))
  const engine = new NativeFileEngine(join(root, 'operations'))
  await engine.ready()
  const files = new SpaceFileService(repository, engine, workspaces)
  cleanup.push(async () => {
    await files.dispose()
    await engine.dispose()
    database.close()
    await rm(root, { recursive: true, force: true })
  })
  const create = (name: string) => spaces.create({ name, memoryScope: 'space_only', primaryDirectory: null, primaryDirectorySelectionVerified: false })
  const targetOf = (space: { id: string }, path = '') => ({ spaceId: space.id, directoryId: spaceWorkspaceDirectoryId(space.id), revision: 1, path })
  return { root, spaces, workspaces, files, create, targetOf, repository }
}

describe('space workspace directory', () => {
  it('derives a directory only while the space has no primary directory', async () => {
    const f = await fixture()
    const space = await f.create('Default folder')
    const directory = f.workspaces.get(space)
    expect(directory).toMatchObject({ id: spaceWorkspaceDirectoryId(space.id), revision: 1, revokedAt: null, spaceId: space.id, root: join(f.root, 'spaces', space.id, 'workspace') })
    expect(directory!.canonicalRoot).toBe(await realpath(directory!.root))

    const workspace = join(f.root, 'chosen')
    await mkdir(workspace)
    const configured = await f.spaces.update({ spaceId: space.id, name: space.name, memoryScope: space.memoryScope, primaryDirectory: { id: null, root: workspace }, primaryDirectorySelectionVerified: true })
    expect(f.workspaces.get(configured)).toBeNull()
    expect(f.workspaces.get({ ...space, revokedAt: new Date().toISOString() })).toBeNull()
  })

  it('browses, edits and manages files in the default folder and hides the app\'s attachment copies', async () => {
    const f = await fixture()
    const space = await f.create('Files')
    const root = f.workspaces.get(space)!.root
    await mkdir(join(root, '.attachments'))
    await writeFile(join(root, 'report.md'), 'draft')

    const listed = await f.files.list(f.targetOf(space))
    expect(listed.entries.map(entry => entry.name)).toEqual(['report.md'])
    const target = f.targetOf(space, 'report.md')
    expect(await f.files.read(target)).toMatchObject({ kind: 'text', text: 'draft' })
    const document = await f.files.readDocument(target)
    const saved = await f.files.saveDocument({ ...target, operationId: randomUUID(), etag: document.etag, text: 'final' })
    expect(saved.status).toBe('saved')
    expect(await readFile(join(root, 'report.md'), 'utf8')).toBe('final')
    await f.files.mutate({ ...f.targetOf(space, 'notes'), operationId: randomUUID(), action: { kind: 'createDirectory' } })
    expect((await f.files.list(f.targetOf(space))).entries.map(entry => entry.name).sort()).toEqual(['notes', 'report.md'])
  })

  it('keeps default folders of different spaces apart', async () => {
    const f = await fixture()
    const first = await f.create('First')
    const second = await f.create('Second')
    await writeFile(join(f.workspaces.get(first)!.root, 'same.md'), 'first')
    await writeFile(join(f.workspaces.get(second)!.root, 'same.md'), 'second')

    expect(await f.files.read(f.targetOf(first, 'same.md'))).toMatchObject({ text: 'first' })
    expect(await f.files.read(f.targetOf(second, 'same.md'))).toMatchObject({ text: 'second' })
    // The first space's directory id never opens the second space's folder.
    await expect(f.files.read({ ...f.targetOf(second, 'same.md'), directoryId: spaceWorkspaceDirectoryId(first.id) })).rejects.toThrow()
    await expect(f.files.read({ ...f.targetOf(first, 'same.md'), spaceId: second.id })).rejects.toThrow()
  })

  it('denies a stale revision, an unknown space and a space that now has a primary directory', async () => {
    const f = await fixture()
    const space = await f.create('Moving on')
    await writeFile(join(f.workspaces.get(space)!.root, 'a.md'), 'a')
    await expect(f.files.read({ ...f.targetOf(space, 'a.md'), revision: 2 })).rejects.toThrow()
    await expect(f.files.read({ ...f.targetOf(space, 'a.md'), spaceId: 'missing' })).rejects.toThrow()

    const workspace = join(f.root, 'chosen')
    await mkdir(workspace)
    await f.spaces.update({ spaceId: space.id, name: space.name, memoryScope: space.memoryScope, primaryDirectory: { id: null, root: workspace }, primaryDirectorySelectionVerified: true })
    await expect(f.files.read(f.targetOf(space, 'a.md'))).rejects.toThrow()
    await expect(f.files.list(f.targetOf(space))).rejects.toThrow()
  })

  it('does not expose a folder outside the default folder', async () => {
    const f = await fixture()
    const space = await f.create('Escape')
    await writeFile(join(f.root, 'outside.md'), 'outside')
    await expect(f.files.read(f.targetOf(space, '../../../../outside.md'))).rejects.toThrow()
  })

  it('serves the default folder with the space list so the file manager can reach it', async () => {
    const f = await fixture()
    const handlers = new Map<string, RuntimeRequestHandler>()
    const rpc: RuntimeRequestRegistrar = {
      onRequest(method, handler) {
        handlers.set(method, handler)
        return () => handlers.delete(method)
      },
    }
    cleanup.push(registerSpaceRpc({ rpc, service: f.spaces, workspaces: f.workspaces }))
    const created = await handlers.get('spaces.create')!({ name: 'Listed', memoryScope: 'space_only', primaryDirectory: null, primaryDirectorySelectionVerified: false }) as { id: string }
    const workspace = join(f.root, 'chosen')
    await mkdir(workspace)
    const withFolder = await handlers.get('spaces.create')!({ name: 'Chosen', memoryScope: 'space_only', primaryDirectory: { id: null, root: workspace }, primaryDirectorySelectionVerified: true }) as { id: string }

    const listed = spacesResponseSchemas.spaces.parse(await handlers.get('spaces.list')!({}))
    const plain = listed.find(space => space.id === created.id)!
    expect(plain.workspaceDirectory).toMatchObject({ id: spaceWorkspaceDirectoryId(created.id), revision: 1 })
    expect(getActiveSpaceDirectories(plain).map(directory => directory.id)).toEqual([spaceWorkspaceDirectoryId(created.id)])
    const chosen = listed.find(space => space.id === withFolder.id)!
    expect(chosen.workspaceDirectory).toBeNull()
    expect(getActiveSpaceDirectories(chosen).map(directory => directory.id)).toEqual([chosen.primaryDirectory!.id])
  })
})
