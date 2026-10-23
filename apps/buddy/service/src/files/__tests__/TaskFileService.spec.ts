import type { DatabaseSync } from 'node:sqlite'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { taskFileMediaUrl } from '../../../../shared/files/mediaPreview'
import { taskFileSchema } from '../../../../shared/files/taskFileApi'
import { ArtifactFileAccess } from '../../artifacts/ArtifactFileAccess'
import { ArtifactService } from '../../artifacts/ArtifactService'
import { createArtifactRepository } from '../../storage/artifactRepository'
import { BuddyDataPaths } from '../../storage/BuddyDataPaths'
import { createConversationDirectoryGrantRepository } from '../../storage/conversationDirectoryGrantRepository'
import { createConversationRepository } from '../../storage/conversationRepository'
import { openBuddyDatabase } from '../../storage/database'
import { createSpaceRepository } from '../../storage/spaceRepository'
import { TaskFileAccess } from '../TaskFileAccess'
import { TaskFileService } from '../TaskFileService'

const databases: DatabaseSync[] = []
const directories: string[] = []
const conversationId = 'conversation-1'
const createdAt = '2026-08-27T00:00:00.000Z'

afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  for (const database of databases.splice(0))
    database.close()
  await Promise.all(directories.splice(0).map(path => rm(path, { force: true, recursive: true })))
})

describe('task file service', () => {
  it.each(['note.md', 'index.html', 'program.ts', 'report.pdf', 'slides.pptx', 'custom.unknown', 'README'])('resolves and reads unregistered %s files without publishing artifacts', async (name) => {
    const f = await fixture()
    const path = join(f.workspace, name)
    await writeFile(path, 'local content')
    const file = await f.service.resolve({ conversationId, href: name })
    expect(taskFileSchema.parse(file)).toMatchObject({ target: { conversationId, path }, name, kind: 'file', sizeBytes: 13 })
    expect(await f.service.read(file.target)).toMatchObject({ kind: 'text', text: 'local content' })
    expect(f.artifacts.listForConversation(conversationId)).toEqual([])
  })

  it('decodes link paths once and retains canonical raw paths for subsequent operations', async () => {
    const f = await fixture()
    const name = '动画 #1 %20.txt'
    const path = join(f.workspace, name)
    await writeFile(path, 'encoded name')
    for (const href of [encodeURIComponent(name), `./${encodeURIComponent(name)}#view`, pathToFileURL(path).href, `sandbox:${pathToFileURL(path).pathname}`]) {
      const file = await f.service.resolve({ conversationId, href })
      expect(file.target.path).toBe(path)
      expect(await f.service.read(file.target)).toMatchObject({ text: 'encoded name' })
      expect(await f.service.locate(file.target)).toEqual({ path, kind: 'file' })
    }
    for (const href of ['https://example.com/index.html', 'file://other-host/file.txt', 'bad%encoding', '#fragment']) {
      await expect(f.service.resolve({ conversationId, href })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
    }
  })

  it('resolves directories but rejects content reads, non-HTML browser entries and non-media streams', async () => {
    const f = await fixture()
    const folder = join(f.workspace, 'folder')
    await mkdir(folder)
    const directory = await f.service.resolve({ conversationId, href: 'folder' })
    expect(directory).toMatchObject({ kind: 'directory', mimeType: 'inode/directory', target: { conversationId, path: folder } })
    expect(await f.service.locate(directory.target)).toEqual({ path: folder, kind: 'directory' })
    await expect(f.service.read(directory.target)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
    const path = join(f.workspace, 'note.txt')
    await writeFile(path, 'note')
    await expect(f.service.resolveBrowser({ conversationId, path })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
    await expect(f.service.resolveMedia({ conversationId, path })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
  })

  it('returns FILE_NOT_FOUND for missing links, raw targets and removed workspaces', async () => {
    const f = await fixture()
    const target = { conversationId, path: join(f.workspace, 'missing.html') }
    await expect(f.service.resolve({ conversationId, href: 'missing.html' })).rejects.toMatchObject({ code: 'FILE_NOT_FOUND' })
    for (const invoke of [() => f.service.read(target), () => f.service.locate(target), () => f.service.resolveMedia(target), () => f.service.resolveBrowser(target)])
      await expect(invoke()).rejects.toMatchObject({ code: 'FILE_NOT_FOUND' })
    await rm(f.workspace, { recursive: true })
    await expect(f.service.resolve({ conversationId, href: 'missing.html' })).rejects.toMatchObject({ code: 'FILE_NOT_FOUND' })
  })

  it('does not misreport an unavailable native reader as a missing target file', async () => {
    const f = await fixture()
    const path = join(f.workspace, 'note.txt')
    await writeFile(path, 'content')
    vi.stubEnv('LEXORA_BUDDY_FILE_READER', join(f.root, 'missing-reader'))
    await expect(f.service.read({ conversationId, path })).rejects.toMatchObject({ code: 'BOUNDED_FILE_READER_UNAVAILABLE' })
  })

  it.each(['task', 'space'] as const)('skips missing and replaced additional %s grants without blocking valid files', async (owner) => {
    const f = await fixture()
    const original = join(f.root, 'original')
    const replacement = join(f.root, 'replacement')
    const alias = join(f.root, 'alias')
    await mkdir(original)
    await mkdir(replacement)
    await symlink(original, alias, 'junction')
    const bindings = [
      { id: 'missing', root: join(f.root, 'missing'), canonicalRoot: join(f.root, 'missing'), accessGrantedAt: createdAt },
      { id: 'replaced', root: alias, canonicalRoot: original, accessGrantedAt: createdAt },
    ]
    if (owner === 'task') {
      for (const binding of bindings)
        f.conversationGrants.grant({ ...binding, conversationId, createdAt })
    }
    else {
      f.spaces.create({ id: 'space', name: 'Files', memoryScope: 'space_only', createdAt, additionalDirectories: bindings, primaryDirectory: {
        id: 'primary',
        root: f.workspace,
        canonicalRoot: f.workspace,
        accessGrantedAt: createdAt,
        resourcesTrustedAt: createdAt,
      } })
      f.conversations.setSpace({ id: conversationId, spaceId: 'space', updatedAt: createdAt })
    }
    await rm(alias)
    await symlink(replacement, alias, 'junction')
    const path = join(f.workspace, 'index.txt')
    await writeFile(path, 'current')
    await writeFile(join(original, 'index.txt'), 'previous')
    await writeFile(join(replacement, 'index.txt'), 'replacement')
    expect(await f.service.resolve({ conversationId, href: 'index.txt' })).toMatchObject({ target: { path } })
    for (const root of [original, replacement, alias])
      await expect(f.service.resolve({ conversationId, href: join(root, 'index.txt') })).rejects.toMatchObject({ code: 'PATH_OUTSIDE_GRANTED_DIRECTORY' })
  })

  it('revalidates grants for reads, browser entries and media, and blocks symlink escapes', async () => {
    const f = await fixture()
    const extra = join(f.root, 'extra')
    await mkdir(extra)
    const path = join(extra, 'index.html')
    const media = join(extra, 'clip %20.mp4')
    await writeFile(path, '<h1>preview</h1>')
    await writeFile(media, 'media')
    await symlink(path, join(f.workspace, 'escape.html'))
    await expect(f.service.resolve({ conversationId, href: 'escape.html' })).rejects.toMatchObject({ code: 'PATH_OUTSIDE_GRANTED_DIRECTORY' })
    f.conversationGrants.grant({ id: 'extra', conversationId, root: extra, canonicalRoot: extra, createdAt })
    const file = await f.service.resolve({ conversationId, href: 'escape.html' })
    expect(file.target.path).toBe(path)
    expect(await f.service.resolveBrowser(file.target)).toEqual({ entryPath: path, rootPath: extra })
    expect(await f.service.read({ conversationId, path: media })).toMatchObject({ kind: 'video', mediaUrl: taskFileMediaUrl({ conversationId, path: media }) })
    expect(await f.service.resolveMedia({ conversationId, path: media })).toMatchObject({ path: media, root: extra, mimeType: 'video/mp4' })
    f.conversationGrants.revokeAll(conversationId, createdAt)
    for (const invoke of [() => f.service.read(file.target), () => f.service.locate(file.target), () => f.service.resolveBrowser(file.target), () => f.service.resolveMedia({ conversationId, path: media })])
      await expect(invoke()).rejects.toMatchObject({ code: 'PATH_OUTSIDE_GRANTED_DIRECTORY' })
  })

  it('uses canonical directory roots for symlink grants and rejects retargeted canonical file paths', async () => {
    const f = await fixture()
    const extra = join(f.root, 'extra')
    const alias = join(f.root, 'alias')
    await mkdir(extra)
    await symlink(extra, alias, 'junction')
    f.conversationGrants.grant({ id: 'extra', conversationId, root: alias, canonicalRoot: extra, createdAt })
    const path = join(extra, 'clip.mp4')
    await writeFile(path, 'media')
    const file = await f.service.resolve({ conversationId, href: join(alias, 'clip.mp4') })
    expect(file.target.path).toBe(path)
    expect(await f.service.resolveMedia(file.target)).toMatchObject({ path, root: extra })
    const other = join(extra, 'other.mp4')
    await writeFile(other, 'other')
    await rm(path)
    await symlink(other, path)
    await expect(f.service.read(file.target)).rejects.toMatchObject({ code: 'DIRECTORY_NOT_AUTHORIZED' })
  })

  it('uses current Space directories without widening links to historical artifact grants', async () => {
    const f = await fixture()
    const old = join(f.root, 'old-grant')
    await mkdir(old)
    f.conversationGrants.grant({ id: 'old', conversationId, root: old, canonicalRoot: old, createdAt })
    const path = join(old, 'historical.html')
    await writeFile(path, '<h1>historical</h1>')
    const artifacts = new ArtifactService({ repository: f.artifacts, fileAccess: new ArtifactFileAccess(f.accessOptions) })
    const [artifact] = await artifacts.presentOutputs({ conversationId, cwd: old, grants: [{ root: old, canonicalRoot: old, grantId: 'old', kind: 'granted' }], paths: [path] })
    const current = join(f.root, 'current')
    await mkdir(current)
    await writeFile(join(current, 'current.md'), 'current')
    f.spaces.create({ id: 'space', name: 'Files', memoryScope: 'space_only', createdAt, additionalDirectories: [], primaryDirectory: {
      id: 'primary',
      root: current,
      canonicalRoot: current,
      accessGrantedAt: createdAt,
      resourcesTrustedAt: createdAt,
    } })
    f.conversations.setSpace({ id: conversationId, spaceId: 'space', updatedAt: createdAt })
    expect(await artifacts.locate(artifact!.id)).toEqual({ path, kind: 'file' })
    await expect(f.service.resolve({ conversationId, href: path })).rejects.toMatchObject({ code: 'PATH_OUTSIDE_GRANTED_DIRECTORY' })
    expect(await f.service.resolve({ conversationId, href: 'current.md' })).toMatchObject({ target: { path: join(current, 'current.md') } })
    f.spaces.delete('space', createdAt, { id: 'deleted', spaceId: 'space', createdAt, eventType: 'space.deleted', payload: {} })
    await expect(f.service.resolve({ conversationId, href: 'current.md' })).rejects.toMatchObject({ code: 'SPACE_UNAVAILABLE' })
    await artifacts.dispose()
  })

  it('revokes previously resolved Space targets without relying on cached metadata', async () => {
    const f = await fixture()
    const primary = join(f.root, 'primary')
    await mkdir(primary)
    const path = join(primary, 'index.html')
    const media = join(primary, 'clip.mp4')
    await writeFile(path, '<h1>preview</h1>')
    await writeFile(media, 'media')
    f.spaces.create({ id: 'space', name: 'Files', memoryScope: 'space_only', createdAt, additionalDirectories: [], primaryDirectory: {
      id: 'primary',
      root: primary,
      canonicalRoot: primary,
      accessGrantedAt: createdAt,
      resourcesTrustedAt: createdAt,
    } })
    f.conversations.setSpace({ id: conversationId, spaceId: 'space', updatedAt: createdAt })
    const file = await f.service.resolve({ conversationId, href: 'index.html' })
    f.spaces.update({ id: 'space', name: 'Files', memoryScope: 'space_only', updatedAt: createdAt, primaryDirectory: null, additionalDirectories: [], event: { id: 'revoked', spaceId: 'space', createdAt, eventType: 'space.config.updated', payload: {} } })
    for (const invoke of [() => f.service.read(file.target), () => f.service.locate(file.target), () => f.service.resolveBrowser(file.target), () => f.service.resolveMedia({ conversationId, path: media })])
      await expect(invoke()).rejects.toMatchObject({ code: 'PATH_OUTSIDE_GRANTED_DIRECTORY' })
  })

  it('rejects deleted tasks and sensitive paths even inside granted roots', async () => {
    const f = await fixture()
    vi.stubEnv('HOME', f.root)
    const sensitive = join(f.root, '.ssh')
    await mkdir(sensitive)
    const path = join(sensitive, 'key')
    await writeFile(path, 'fixture')
    f.conversationGrants.grant({ id: 'sensitive', conversationId, root: sensitive, canonicalRoot: sensitive, createdAt })
    await expect(f.service.resolve({ conversationId, href: path })).rejects.toMatchObject({ code: 'DIRECTORY_NOT_AUTHORIZED' })
    f.conversationGrants.revokeAll(conversationId, createdAt)
    await rm(sensitive, { recursive: true })
    const aliased = join(f.root, 'aliased')
    await mkdir(aliased)
    await writeFile(join(aliased, 'key'), 'fixture')
    await symlink(aliased, sensitive, 'junction')
    f.conversationGrants.grant({ id: 'sensitive-alias', conversationId, root: sensitive, canonicalRoot: aliased, createdAt })
    await expect(f.service.resolve({ conversationId, href: join(aliased, 'key') })).rejects.toMatchObject({ code: 'DIRECTORY_NOT_AUTHORIZED' })
    const ordinary = join(f.workspace, 'ordinary.txt')
    await writeFile(ordinary, 'ordinary')
    f.conversations.markDeleted(conversationId, createdAt)
    await expect(f.service.read({ conversationId, path: ordinary })).rejects.toMatchObject({ code: 'DIRECTORY_NOT_AUTHORIZED' })
  })

  it('does not return file content when access is revoked after the initial validation', async () => {
    const f = await fixture()
    const extra = join(f.root, 'extra')
    await mkdir(extra)
    f.conversationGrants.grant({ id: 'extra', conversationId, root: extra, canonicalRoot: extra, createdAt })
    const path = join(extra, 'note.txt')
    await writeFile(path, 'private')
    const resolve = f.access.resolve.bind(f.access)
    vi.spyOn(f.access, 'resolve').mockImplementationOnce(async (target) => {
      const location = await resolve(target)
      f.conversationGrants.revokeAll(conversationId, createdAt)
      return location
    })
    await expect(f.service.read({ conversationId, path })).rejects.toMatchObject({ code: 'PATH_OUTSIDE_GRANTED_DIRECTORY' })
  })
})

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'lexora-task-file-')))
  directories.push(root)
  const database = openBuddyDatabase({ databasePath: ':memory:' })
  databases.push(database)
  const paths = new BuddyDataPaths(root)
  const workspace = paths.conversationWorkspace(conversationId)
  await mkdir(workspace, { recursive: true })
  const conversations = createConversationRepository(database)
  conversations.create({ id: conversationId, branchId: 'branch-1', spaceId: null, title: 'Task', approvalPolicy: 'policy', executionProfile: 'workspace_write', createdAt })
  const conversationGrants = createConversationDirectoryGrantRepository(database)
  const spaces = createSpaceRepository(database)
  const accessOptions = { conversations, conversationGrants, spaces, paths }
  const access = new TaskFileAccess(accessOptions)
  return { root, workspace, conversations, conversationGrants, spaces, paths, access, accessOptions, artifacts: createArtifactRepository(database), service: new TaskFileService(access) }
}
