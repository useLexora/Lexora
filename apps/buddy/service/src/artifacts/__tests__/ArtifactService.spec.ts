import type { DatabaseSync } from 'node:sqlite'
import type { DirectoryGrant } from '../../directories/resolveGrantedPath'
import type { ArtifactEvent } from '../ArtifactService'
import { Buffer } from 'node:buffer'
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import { TaskFileAccess } from '../../files/TaskFileAccess'
import { TaskFileService } from '../../files/TaskFileService'
import { createArtifactRepository } from '../../storage/artifactRepository'
import { BuddyDataPaths } from '../../storage/BuddyDataPaths'
import { createConversationDirectoryGrantRepository } from '../../storage/conversationDirectoryGrantRepository'
import { createConversationRepository } from '../../storage/conversationRepository'
import { openBuddyDatabase } from '../../storage/database'
import { createSpaceRepository } from '../../storage/spaceRepository'
import { ArtifactFileAccess } from '../ArtifactFileAccess'
import { ArtifactService } from '../ArtifactService'

const databases: DatabaseSync[] = []
const directories: string[] = []

afterEach(async () => {
  for (const database of databases.splice(0))
    database.close()
  await Promise.all(directories.splice(0).map(path => rm(path, { force: true, recursive: true })))
})

describe('artifactService', () => {
  it('materializes an image reference only within current grants and rejects revoked or replaced files', async () => {
    const fixture = await createFixture()
    const conversationGrants = createConversationDirectoryGrantRepository(fixture.database)
    conversationGrants.grant({ conversationId: 'conversation-1', id: 'workspace-1', root: fixture.workspace, canonicalRoot: fixture.workspace, createdAt: '2026-08-27T00:00:00.000Z' })
    const service = new ArtifactService({ repository: fixture.repository, fileAccess: new ArtifactFileAccess({ conversations: createConversationRepository(fixture.database), conversationGrants, spaces: createSpaceRepository(fixture.database), paths: new BuddyDataPaths(fixture.root) }) })
    const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAFElEQVR4AQEJAPb/AAD/AP//AAD/EPgD/UE7EkoAAAAASUVORK5CYII=', 'base64')
    const path = join(fixture.workspace, 'reference.png')
    await writeFile(path, bytes)
    const [artifact] = await service.presentOutputs({ conversationId: 'conversation-1', cwd: fixture.workspace, grants: fixture.grants, paths: [path] })
    const access = { cwd: fixture.workspace, grants: fixture.grants }
    await expect(service.materializeConversationImages('conversation-1', [artifact!.id], access)).resolves.toMatchObject({ images: [{ data: bytes.toString('base64'), mimeType: 'image/png' }] })
    await expect(service.materializeConversationImages('conversation-1', [artifact!.id])).rejects.toMatchObject({ code: 'DIRECTORY_NOT_AUTHORIZED' })
    await expect(service.materializeConversationImages('conversation-1', [artifact!.id], { ...access, grants: [] })).rejects.toMatchObject({ code: 'PATH_OUTSIDE_GRANTED_DIRECTORY' })
    const outside = join(fixture.root, 'outside.png')
    await writeFile(outside, bytes)
    await rm(path)
    await symlink(outside, path)
    await expect(service.materializeConversationImages('conversation-1', [artifact!.id], access)).rejects.toThrow()
    await rm(path)
    await writeFile(path, bytes)
    conversationGrants.revokeAll('conversation-1', '2026-08-28T00:00:00.000Z')
    await expect(service.materializeConversationImages('conversation-1', [artifact!.id], access)).rejects.toMatchObject({ code: 'DIRECTORY_NOT_AUTHORIZED' })
  })

  it('publishes an independent generated file and refuses revoked publication before promotion', async () => {
    const f = await createFixture()
    const path = join(f.workspace, 'outputs', 'document.docx')
    const bytes = Uint8Array.of(80, 75, 3, 4)
    const record = await f.service.registerGeneratedFile({ conversationId: 'conversation-1', cwd: f.workspace, grants: f.grants, outputPath: path, bytes, assertCurrent: () => {} })
    bytes[0] = 0
    expect(await readFile(record.currentPath)).toEqual(Buffer.from([80, 75, 3, 4]))
    expect(f.repository.findById(record.id)).toMatchObject({ name: 'document.docx', conversationId: 'conversation-1', sizeBytes: 4 })
    let checks = 0
    const revoked = join(f.workspace, 'outputs', 'revoked.docx')
    await expect(f.service.registerGeneratedFile({ conversationId: 'conversation-1', cwd: f.workspace, grants: f.grants, outputPath: revoked, bytes, assertCurrent: () => {
      if (++checks === 3)
        throw new Error('revoked')
    } })).rejects.toMatchObject({ receipt: { outcome: 'failed', written: 0, artifactIds: [] } })
    await expect(readFile(revoked)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(f.repository.listForConversation('conversation-1')).toHaveLength(1)
    await expect(f.service.registerGeneratedFile({ conversationId: 'conversation-1', cwd: f.workspace, grants: f.grants, outputPath: path, bytes, assertCurrent: () => {} })).rejects.toThrow()
    expect(await readFile(path)).toEqual(Buffer.from([80, 75, 3, 4]))
  })

  it.each([`${'a'.repeat(216)}.txt`, `${'文'.repeat(75)}.txt`])('publishes a long filename without lengthening its temporary basename: %s', async (name) => {
    const fixture = await createFixture()
    const outputPath = join(fixture.workspace, name)
    const bytes = Buffer.from('Generated content')
    const artifact = await fixture.service.registerGeneratedFile({ conversationId: 'conversation-1', cwd: fixture.workspace, grants: fixture.grants, outputPath, bytes, assertCurrent: () => {} })
    expect(await readFile(outputPath)).toEqual(bytes)
    expect(fixture.repository.findById(artifact.id)).toMatchObject({ currentPath: outputPath, name, sizeBytes: bytes.length })
    expect(await readdir(fixture.workspace)).toEqual([name])
  })

  it('retains historical HTML artifact access after moving into a Space without granting the old workspace to new links', async () => {
    const fixture = await createFixture()
    const paths = new BuddyDataPaths(fixture.root)
    const conversations = createConversationRepository(fixture.database)
    const spaces = createSpaceRepository(fixture.database)
    const workspace = paths.conversationWorkspace('conversation-1')
    const createdAt = '2026-08-27T00:00:00.000Z'
    await mkdir(workspace, { recursive: true })
    const path = join(workspace, 'index.html')
    await writeFile(path, '<h1>Historical output</h1>')
    const service = new ArtifactService({ repository: fixture.repository, fileAccess: new ArtifactFileAccess({
      conversations,
      spaces,
      paths,
      conversationGrants: createConversationDirectoryGrantRepository(fixture.database),
    }) })
    const [artifact] = await service.presentOutputs({ conversationId: 'conversation-1', cwd: workspace, grants: [{ root: workspace, canonicalRoot: workspace, grantId: 'conversation-1', kind: 'workspace' }], paths: [path] })
    spaces.create({ id: 'space', name: 'Files', memoryScope: 'space_only', createdAt, additionalDirectories: [], primaryDirectory: null })
    conversations.setSpace({ id: 'conversation-1', spaceId: 'space', updatedAt: createdAt })
    await mkdir(paths.spaceWorkspace('space'), { recursive: true })
    await expect(service.resolveBrowserEntry('conversation-1', artifact!.id)).resolves.toEqual({ entryPath: path, rootPath: workspace })
    const taskFiles = new TaskFileService(new TaskFileAccess({ conversations, spaces, paths, conversationGrants: createConversationDirectoryGrantRepository(fixture.database) }))
    await expect(taskFiles.resolve({ conversationId: 'conversation-1', href: path })).rejects.toMatchObject({ code: 'PATH_OUTSIDE_GRANTED_DIRECTORY' })
  })

  it('preserves extensionless image MIME and resolves media and reveal locations only while the recorded grant is active', async () => {
    const fixture = await createFixture()
    const conversationGrants = createConversationDirectoryGrantRepository(fixture.database)
    conversationGrants.grant({ conversationId: 'conversation-1', id: 'workspace-1', root: fixture.workspace, canonicalRoot: fixture.workspace, createdAt: '2026-08-27T00:00:00.000Z' })
    const service = new ArtifactService({ repository: fixture.repository, fileAccess: new ArtifactFileAccess({
      conversations: createConversationRepository(fixture.database),
      conversationGrants,
      spaces: createSpaceRepository(fixture.database),
      paths: new BuddyDataPaths(fixture.root),
    }) })
    const imagePath = join(fixture.workspace, 'preview')
    const path = join(fixture.workspace, 'track.mp3')
    await writeFile(imagePath, Uint8Array.of(137, 80, 78, 71))
    await writeFile(path, 'media')
    const [image, artifact] = await service.presentOutputs({ conversationId: 'conversation-1', cwd: fixture.workspace, grants: fixture.grants, paths: [imagePath, path] })
    fixture.repository.save({ ...image!, mimeType: 'image/png' })
    expect(await service.resolveMedia(image!.id)).toMatchObject({ root: fixture.workspace, path: imagePath, mimeType: 'image/png', sizeBytes: 4, identity: expect.any(String) })
    expect(await service.resolveMedia(artifact!.id)).toMatchObject({ path, root: fixture.workspace, mimeType: 'audio/mpeg', sizeBytes: 5 })
    expect(await service.locate(artifact!.id)).toEqual({ path, kind: 'file' })
    conversationGrants.revokeAll('conversation-1', '2026-08-28T00:00:00.000Z')
    await expect(service.resolveMedia(artifact!.id)).rejects.toMatchObject({ code: 'DIRECTORY_NOT_AUTHORIZED' })
    await expect(service.locate(artifact!.id)).rejects.toMatchObject({ code: 'DIRECTORY_NOT_AUTHORIZED' })
    expect(await readFile(path, 'utf8')).toBe('media')
  })

  it('supports owned task workspaces without a Space, rejecting replaced paths and deleted owners', async () => {
    const fixture = await createFixture()
    const paths = new BuddyDataPaths(fixture.root)
    const workspace = paths.conversationWorkspace('conversation-1')
    await mkdir(workspace, { recursive: true })
    const service = new ArtifactService({ repository: fixture.repository, fileAccess: new ArtifactFileAccess({
      conversations: createConversationRepository(fixture.database),
      conversationGrants: createConversationDirectoryGrantRepository(fixture.database),
      spaces: createSpaceRepository(fixture.database),
      paths,
    }) })
    const path = join(workspace, 'video.webm')
    await writeFile(path, 'media')
    const [artifact] = await service.presentOutputs({ conversationId: 'conversation-1', cwd: workspace, grants: [{ root: workspace, canonicalRoot: workspace, grantId: 'conversation-1', kind: 'workspace' }], paths: [path] })
    expect(await service.resolveMedia(artifact!.id)).toMatchObject({ path, mimeType: 'video/webm' })
    const outside = join(fixture.root, 'private.webm')
    await writeFile(outside, 'private')
    await rm(path)
    await symlink(outside, path)
    await expect(service.resolveMedia(artifact!.id)).rejects.toThrow()
    await expect(service.locate(artifact!.id)).rejects.toThrow()
    await rm(path)
    await writeFile(path, 'media')
    createConversationRepository(fixture.database).markDeleted('conversation-1', '2026-08-28T00:00:00.000Z')
    await expect(service.resolveMedia(artifact!.id)).rejects.toMatchObject({ code: 'ARTIFACT_NOT_FOUND' })
  })

  it('retains written files and committed catalogue rows when a later row fails', async () => {
    const fixture = await createFixture()
    let saves = 0
    const service = new ArtifactService({ repository: { ...fixture.repository, save(record) {
      if (++saves === 2)
        throw new Error('private storage detail')
      return fixture.repository.save(record)
    } }, onListenerError: () => {} })
    const events: ArtifactEvent[] = []
    service.onDidChange(() => {
      throw new Error('observer detail')
    })
    service.onDidChange(event => events.push(event))
    await expect(service.registerGeneratedImages({ conversationId: 'conversation-1', cwd: fixture.workspace, grants: fixture.grants, outputPath: 'result.png', sourceArtifactId: null, images: [{ bytes: Uint8Array.of(1), mimeType: 'image/png' }, { bytes: Uint8Array.of(2), mimeType: 'image/png' }] })).rejects.toMatchObject({ receipt: { outcome: 'partial', written: 2, unconfirmedWrites: 0, stage: 'catalogue', artifactIds: [expect.any(String)] } })
    expect(events.map(event => event.kind)).toEqual(['file-written', 'file-written', 'catalogue-committed', 'batch-settled'])
    const receipt = events.at(-1)!.receipt
    expect(fixture.repository.listForConversation('conversation-1').map(record => record.id)).toEqual(receipt.artifactIds)
    expect(await readFile(join(fixture.workspace, 'result.png'))).toEqual(Buffer.from([1]))
    expect(await readFile(join(fixture.workspace, 'result-2.png'))).toEqual(Buffer.from([2]))
    expect(JSON.stringify(events)).not.toContain(fixture.workspace)
    expect(JSON.stringify(events)).not.toContain('private storage detail')
    await service.dispose()
  })

  it('reports an unsuccessful file write separately from confirmed writes', async () => {
    const fixture = await createFixture()
    await mkdir(join(fixture.workspace, 'result-2.png'))
    await expect(fixture.service.registerGeneratedImages({ conversationId: 'conversation-1', cwd: fixture.workspace, grants: fixture.grants, outputPath: 'result.png', sourceArtifactId: null, images: [{ bytes: Uint8Array.of(1), mimeType: 'image/png' }, { bytes: Uint8Array.of(2), mimeType: 'image/png' }] })).rejects.toMatchObject({ receipt: { outcome: 'partial', written: 1, unconfirmedWrites: 1, artifactIds: [], stage: 'file' } })
    expect(await readFile(join(fixture.workspace, 'result.png'))).toEqual(Buffer.from([1]))
    expect(fixture.repository.listForConversation('conversation-1')).toEqual([])
  })

  it('isolates accepted bytes and grants and drains their publication before disposal', async () => {
    const fixture = await createFixture()
    const bytes = Uint8Array.of(1, 2, 3)
    const events: ArtifactEvent[] = []
    fixture.service.onDidChange(event => events.push(event))
    const pending = fixture.service.registerGeneratedImages({ conversationId: 'conversation-1', cwd: fixture.workspace, grants: fixture.grants, outputPath: 'result.png', sourceArtifactId: null, images: [{ bytes, mimeType: 'image/png' }] })
    bytes.fill(9)
    fixture.grants[0]!.canonicalRoot = fixture.root
    fixture.grants.length = 0
    const stopping = fixture.service.dispose()
    const [artifact] = await pending
    await stopping
    expect(await readFile(artifact!.currentPath)).toEqual(Buffer.from([1, 2, 3]))
    expect(events.at(-1)).toMatchObject({ kind: 'batch-settled', receipt: { outcome: 'completed', written: 1, artifactIds: [artifact!.id] } })
    await expect(fixture.service.presentOutputs({ conversationId: 'conversation-1', cwd: fixture.workspace, grants: [], paths: [artifact!.currentPath] })).rejects.toMatchObject({ code: 'ARTIFACT_SERVICE_STOPPED' })
  })

  it('presents explicitly selected files and directories as separate outputs', async () => {
    const fixture = await createFixture()
    const directoryPath = join(fixture.workspace, 'site')
    const filePath = join(directoryPath, 'index.html')
    await mkdir(directoryPath)
    await writeFile(filePath, '<h1>Hello</h1>')

    const artifacts = await fixture.service.presentOutputs({
      conversationId: 'conversation-1',
      cwd: fixture.workspace,
      grants: fixture.grants,
      paths: [filePath, directoryPath],
    })

    expect(artifacts).toEqual([
      expect.objectContaining({
        currentPath: filePath,
        kind: 'file',
        mimeType: 'text/html',
        name: 'index.html',
        relativePath: 'site/index.html',
        sizeBytes: Buffer.byteLength('<h1>Hello</h1>'),
      }),
      expect.objectContaining({
        currentPath: directoryPath,
        kind: 'directory',
        mimeType: 'inode/directory',
        name: 'site',
        relativePath: 'site',
        sizeBytes: 0,
      }),
    ])
    expect(fixture.service.listConversationArtifacts('conversation-1')).toHaveLength(2)
  })

  it('reads legacy Markdown non-destructively and reports missing files', async () => {
    const fixture = await createFixture()
    const directory = join(fixture.workspace, 'reports')
    const path = join(directory, 'REPORT.MD')
    const text = '# Route plan\n\n| Stop | Distance |\n| --- | --- |\n| Riverside | 20 km |\n'
    await mkdir(directory)
    await writeFile(path, text)
    const [artifact] = await fixture.service.presentOutputs({
      conversationId: 'conversation-1',
      cwd: fixture.workspace,
      grants: fixture.grants,
      paths: [path],
    })
    fixture.database.prepare('UPDATE artifacts SET mime_type = ? WHERE id = ?').run('application/octet-stream', artifact!.id)
    await expect(fixture.service.readText(artifact!.id)).resolves.toEqual({ artifactId: artifact!.id, language: 'markdown', text })
    expect(fixture.repository.findVisibleById(artifact!.id)?.mimeType).toBe('application/octet-stream')
    await expect(readFile(path, 'utf8')).resolves.toBe(text)
    await rm(path)
    await expect(fixture.service.readText(artifact!.id)).rejects.toMatchObject({ code: 'FILE_NOT_FOUND' })
    await rm(directory, { recursive: true })
    await writeFile(directory, 'not a directory')
    await expect(fixture.service.readText(artifact!.id)).rejects.toMatchObject({ code: 'FILE_NOT_FOUND' })
  })

  it('rejects an output outside the granted directories', async () => {
    const fixture = await createFixture()
    const sourcePath = join(fixture.root, 'outside.svg')
    await writeFile(sourcePath, '<svg></svg>')

    await expect(fixture.service.presentOutputs({
      conversationId: 'conversation-1',
      cwd: fixture.workspace,
      grants: fixture.grants,
      paths: [sourcePath],
    })).rejects.toMatchObject({ code: 'PATH_OUTSIDE_GRANTED_DIRECTORY' })
  })

  it('writes and updates generated images without deleting files when their conversation is hidden', async () => {
    const fixture = await createFixture()
    const first = await fixture.service.registerGeneratedImages({
      conversationId: 'conversation-1',
      cwd: fixture.workspace,
      grants: fixture.grants,
      images: [
        { bytes: Uint8Array.from([1, 2, 3]), mimeType: 'image/png' },
        { bytes: Uint8Array.from([4, 5, 6]), mimeType: 'image/png' },
      ],
      outputPath: 'images/avatar.png',
      sourceArtifactId: null,
    })

    expect(first.map(artifact => artifact.relativePath)).toEqual([
      'images/avatar.png',
      'images/avatar-2.png',
    ])
    await expect(readFile(join(fixture.workspace, 'images', 'avatar.png')))
      .resolves
      .toEqual(Buffer.from([1, 2, 3]))

    const [updated] = await fixture.service.registerGeneratedImages({
      conversationId: 'conversation-1',
      cwd: fixture.workspace,
      grants: fixture.grants,
      images: [{ bytes: Uint8Array.from([7, 8, 9]), mimeType: 'image/png' }],
      outputPath: 'images/avatar.png',
      sourceArtifactId: first[0]!.id,
    })

    expect(updated!.id).toBe(first[0]!.id)
    expect(updated!.sourceArtifactId).toBeNull()
    createConversationRepository(fixture.database).markDeleted(
      'conversation-1',
      '2026-08-27T00:00:00.000Z',
    )

    expect(fixture.repository.findVisibleById(updated!.id)).toBeNull()
    expect(() => fixture.service.resolvePreview(updated!.id))
      .toThrow(expect.objectContaining({ code: 'ARTIFACT_NOT_FOUND' }))
    await expect(readFile(join(fixture.workspace, 'images', 'avatar.png')))
      .resolves
      .toEqual(Buffer.from([7, 8, 9]))
  })
})

async function createFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'lexora-buddy-artifact-')))
  directories.push(root)
  const workspacePath = join(root, 'workspace')
  await mkdir(workspacePath)
  const workspace = await realpath(workspacePath)
  const database = openBuddyDatabase({ databasePath: ':memory:' })
  databases.push(database)
  createConversationRepository(database).create({
    id: 'conversation-1',
    branchId: 'branch-1',
    spaceId: null,
    title: 'Conversation',
    approvalPolicy: 'policy',
    executionProfile: 'workspace_write',
    createdAt: '2026-08-27T00:00:00.000Z',
  })
  const repository = createArtifactRepository(database)
  const grants: DirectoryGrant[] = [{
    canonicalRoot: workspace,
    grantId: 'workspace-1',
    kind: 'workspace' as const,
    root: workspace,
  }]
  return {
    database,
    grants,
    repository,
    root,
    service: new ArtifactService({ repository }),
    workspace,
  }
}
