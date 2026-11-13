import type { DirectoryGrant } from '../../directories/resolveGrantedPath'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ArtifactService } from '../../artifacts/ArtifactService'
import { createArtifactRepository } from '../../storage/artifactRepository'
import { createConversationRepository } from '../../storage/conversationRepository'
import { openBuddyDatabase } from '../../storage/database'
import { ImageGenerationMaterialError, ImageGenerationMaterialStore } from '../ImageGenerationMaterialStore'
import { createImagePublicationFixture } from './imagePublicationFixture'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAFElEQVR4AQEJAPb/AAD/AP//AAD/EPgD/UE7EkoAAAAASUVORK5CYII=', 'base64')
const image = { bytes: png, mimeType: 'image/png' as const }
let fixtureRoot: string
let root: string
let grants: DirectoryGrant[]
let publication: ReturnType<typeof createImagePublicationFixture>

beforeEach(async () => {
  fixtureRoot = await realpath(await mkdtemp(join(tmpdir(), 'image-generation-material-')))
  root = join(fixtureRoot, 'scratch')
  await mkdir(root)
  grants = [{ canonicalRoot: root, root, kind: 'workspace', grantId: 'scratch' }]
  publication = createImagePublicationFixture(fixtureRoot)
})

afterEach(async () => {
  await publication.dispose()
  await rm(fixtureRoot, { recursive: true, force: true })
})

describe('owned image generation materials', () => {
  it('keeps independent originals and permits registration through the existing file presentation path', async () => {
    const materials = new ImageGenerationMaterialStore(root, 'conversation-1')
    const retained = await Promise.all([materials.write(image, grants, publication.writeFiles), materials.write(image, grants, publication.writeFiles)])
    expect(new Set(retained.map(output => output.path)).size).toBe(2)
    for (const output of retained) {
      expect(output).toEqual({ path: expect.stringContaining(join(root, '.image-generation', 'conversation-1')), mimeType: 'image/png', sizeBytes: png.length, sha256: createHash('sha256').update(png).digest('hex') })
      expect(await readFile(output.path)).toEqual(png)
      if (process.platform !== 'win32')
        expect((await stat(output.path)).mode & 0o777).toBe(0o600)
    }
    const destination = join(root, 'delivered.png')
    await copyFile(retained[0]!.path, destination)
    const database = openBuddyDatabase({ databasePath: ':memory:' })
    createConversationRepository(database).create({ id: 'conversation-1', branchId: 'branch-1', spaceId: null, title: 'Fixture', approvalPolicy: 'policy', executionProfile: 'workspace_write', createdAt: '2026-08-27T00:00:00.000Z' })
    const service = new ArtifactService({ repository: createArtifactRepository(database) })
    try {
      const artifacts = await service.presentOutputs({ conversationId: 'conversation-1', cwd: root, grants, paths: [retained[0]!.path, destination] })
      expect(artifacts.map(artifact => ({ path: artifact.currentPath, mimeType: artifact.mimeType, sizeBytes: artifact.sizeBytes }))).toEqual([
        { path: retained[0]!.path, mimeType: 'image/png', sizeBytes: png.length },
        { path: destination, mimeType: 'image/png', sizeBytes: png.length },
      ])
      await writeFile(destination, 'replaced user output')
      expect(await readFile(retained[0]!.path)).toEqual(png)
      await rm(destination)
      expect(await readFile(retained[0]!.path)).toEqual(png)
    }
    finally {
      await service.dispose()
      database.close()
    }
  })

  it.each(['scratch', 'collection', 'conversation'])('rejects a redirected %s before writing outside owned scratch', async (kind) => {
    const outside = await realpath(await mkdtemp(join(tmpdir(), 'image-generation-outside-')))
    try {
      let scratch = root
      let link: string
      if (kind === 'scratch') {
        scratch = join(root, 'linked-scratch')
        link = scratch
      }
      else if (kind === 'collection') {
        link = join(root, '.image-generation')
      }
      else {
        await mkdir(join(root, '.image-generation'))
        link = join(root, '.image-generation', 'conversation-1')
      }
      await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
      const externalGrant: DirectoryGrant = { canonicalRoot: outside, root: outside, kind: 'granted', grantId: 'external' }
      await expect(new ImageGenerationMaterialStore(scratch, 'conversation-1').write(image, [...grants, externalGrant], publication.writeFiles)).rejects.toMatchObject({ code: 'IMAGE_MATERIAL_IDENTITY_CHANGED' })
      expect(await readdir(outside)).toEqual([])
    }
    finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('rejects a transient parent substitution at the native publication boundary without leaving outside files', async () => {
    const directory = join(root, '.image-generation', 'conversation-1')
    const outside = join(fixtureRoot, 'outside')
    const backup = join(root, '.image-generation', 'original')
    await mkdir(directory, { recursive: true })
    await mkdir(outside)
    const mutate = publication.engine.mutate.bind(publication.engine)
    let swapped = false
    vi.spyOn(publication.engine, 'mutate').mockImplementation(async (request) => {
      if (request.action.kind !== 'writeFile')
        return mutate(request)
      await rename(directory, backup)
      await symlink(outside, directory, process.platform === 'win32' ? 'junction' : 'dir')
      swapped = true
      try {
        return await mutate(request)
      }
      finally {
        await unlink(directory)
        await rename(backup, directory)
      }
    })
    await expect(new ImageGenerationMaterialStore(root, 'conversation-1').write(image, grants, publication.writeFiles)).rejects.toMatchObject({ code: 'FILE_PERMISSION_REVOKED' })
    expect(swapped).toBe(true)
    expect(await readdir(outside)).toEqual([])
    expect(await readdir(directory)).toEqual([])
  })

  it('does not replace a file which appeared at the chosen original path', async () => {
    let path = ''
    await expect(new ImageGenerationMaterialStore(root, 'conversation-1').write(image, grants, async (paths, write) => {
      path = paths[0]!
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, 'existing original')
      await publication.writeFiles(paths, write)
    })).rejects.toThrow('FILE_CONFLICT')
    expect(await readFile(path, 'utf8')).toBe('existing original')
  })

  it('keeps a confirmed original when native publication cleanup fails after cancellation', async () => {
    const controller = new AbortController()
    const error = await new ImageGenerationMaterialStore(root, 'conversation-1').write(image, grants, async (paths, write) => {
      await publication.writeFiles(paths, write)
      controller.abort()
      throw new Error('publication cleanup failed')
    }, controller.signal).catch(error => error)
    expect(error).toBeInstanceOf(ImageGenerationMaterialError)
    expect(error.retainedOutput).toMatchObject({ mimeType: 'image/png', sizeBytes: png.length, sha256: createHash('sha256').update(png).digest('hex') })
    expect(await readFile(error.retainedOutput.path)).toEqual(png)
  })

  it('requires the explicit execution grant and rejects cancellation before creating directories', async () => {
    const store = new ImageGenerationMaterialStore(root, 'conversation-1')
    await expect(store.write(image, [], publication.writeFiles)).rejects.toMatchObject({ code: 'PATH_OUTSIDE_GRANTED_DIRECTORY' })
    expect(await readdir(root)).toEqual([])
    await expect(store.write(image, grants, publication.writeFiles, AbortSignal.abort())).rejects.toMatchObject({ name: 'AbortError' })
    expect(await readdir(root)).toEqual([])
    expect(() => new ImageGenerationMaterialStore(root, '../other')).toThrow('owner')
  })
})
