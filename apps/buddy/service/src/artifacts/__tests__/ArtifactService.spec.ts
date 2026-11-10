import type { DatabaseSync } from 'node:sqlite'
import type { CapturedFileWriter } from '../../changes/CapturedFileWriter'
import type { DirectoryGrant } from '../../directories/resolveGrantedPath'
import type { ArtifactEvent } from '../ArtifactService'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import { MutationCoordinator } from '../../changes/MutationCoordinator'
import { FileResourceCoordinator } from '../../files/FileResourceCoordinator'
import { NativeFileEngine } from '../../files/NativeFileEngine'
import { createArtifactRepository } from '../../storage/artifactRepository'
import { createConversationDirectoryGrantRepository } from '../../storage/conversationDirectoryGrantRepository'
import { createConversationRepository } from '../../storage/conversationRepository'
import { openBuddyDatabase } from '../../storage/database'
import { ArtifactService, BUDDY_ARTIFACT_TEXT_BYTES_LIMIT } from '../ArtifactService'

const databases: DatabaseSync[] = []
const directories: string[] = []
const publications: ReturnType<typeof createArtifactPublicationFixture>[] = []

afterEach(async () => {
  for (const publication of publications.splice(0))
    await publication.dispose()
  for (const database of databases.splice(0))
    database.close()
  await Promise.all(directories.splice(0).map(path => rm(path, { force: true, recursive: true })))
})

describe('artifactService', () => {
  it('keeps delivered files and extensionless image MIME readable after grant revocation and service recreation without granting new outputs', async () => {
    const f = await createFixture()
    const conversationGrants = createConversationDirectoryGrantRepository(f.database)
    conversationGrants.grant({ conversationId: 'conversation-1', id: 'workspace-1', root: f.workspace, canonicalRoot: f.workspace, createdAt: '2026-08-27T00:00:00.000Z' })
    const paths = ['preview', 'report.txt', 'index.html'].map(name => join(f.workspace, name))
    await writeFile(paths[0]!, 'image')
    await writeFile(paths[1]!, 'delivered text')
    await writeFile(paths[2]!, '<h1>Delivered</h1>')
    const records = await f.service.presentOutputs({ conversationId: 'conversation-1', cwd: f.workspace, grants: [{ ...f.grants[0]!, grantId: 'run:finished:call:0' }], paths })
    f.repository.save({ ...records[0]!, mimeType: 'image/png' })
    conversationGrants.revokeAll('conversation-1', '2026-08-28T00:00:00.000Z')
    const service = new ArtifactService({ repository: f.repository })
    await expect(service.resolveMedia(records[0]!.id)).resolves.toMatchObject({ path: paths[0], mimeType: 'image/png' })
    await expect(service.locate(records[0]!.id)).resolves.toEqual({ path: paths[0], kind: 'file' })
    await expect(service.readText(records[1]!.id)).resolves.toMatchObject({ text: 'delivered text' })
    await expect(service.resolveBrowserEntry('conversation-1', records[2]!.id)).resolves.toEqual({ entryPath: paths[2], rootPath: f.workspace })
    await expect(service.resolveBrowserEntry('another-conversation', records[2]!.id)).rejects.toMatchObject({ code: 'ARTIFACT_NOT_FOUND' })
    await expect(service.presentOutputs({ conversationId: 'conversation-1', cwd: f.workspace, grants: [], paths: [paths[1]!] })).rejects.toMatchObject({ code: 'PATH_OUTSIDE_GRANTED_DIRECTORY' })
    for (const path of paths) await rm(path)
    await expect(service.resolveMedia(records[0]!.id)).rejects.toMatchObject({ code: 'FILE_NOT_FOUND' })
    await expect(service.locate(records[0]!.id)).rejects.toMatchObject({ code: 'FILE_NOT_FOUND' })
    await expect(service.readText(records[1]!.id)).rejects.toMatchObject({ code: 'FILE_NOT_FOUND' })
    await expect(service.resolveBrowserEntry('conversation-1', records[2]!.id)).rejects.toMatchObject({ code: 'FILE_NOT_FOUND' })
    await service.dispose()
  })

  it('bounds text by current bytes rather than publication metadata and rejects non-text content', async () => {
    const f = await createFixture()
    const path = join(f.workspace, 'report.txt')
    await writeFile(path, 'small')
    const [record] = await f.service.presentOutputs({ conversationId: 'conversation-1', cwd: f.workspace, grants: f.grants, paths: [path] })
    await writeFile(path, Buffer.alloc(BUDDY_ARTIFACT_TEXT_BYTES_LIMIT + 1, 65))
    await expect(f.service.readText(record!.id)).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' })
    await f.service.presentOutputs({ conversationId: 'conversation-1', cwd: f.workspace, grants: f.grants, paths: [path] })
    await writeFile(path, 'small again')
    await expect(f.service.readText(record!.id)).resolves.toMatchObject({ text: 'small again' })
    await writeFile(path, Buffer.from([0xFF]))
    await expect(f.service.readText(record!.id)).rejects.toMatchObject({ code: 'FILE_UNSUPPORTED' })
    await rm(path)
    await mkdir(path)
    await expect(f.service.readText(record!.id)).rejects.toMatchObject({ code: 'FILE_UNSUPPORTED' })
  })

  it.each(['public.pem', '.env'])('does not infer secrets from an authorized output name: %s', async (name) => {
    const f = await createFixture()
    const path = join(f.workspace, name)
    await writeFile(path, 'synthetic public fixture')
    const [record] = await f.service.presentOutputs({ conversationId: 'conversation-1', cwd: f.workspace, grants: f.grants, paths: [path] })
    await expect(f.service.locate(record!.id)).resolves.toEqual({ path, kind: 'file' })
  })

  it('refuses generated publication without a controlled file writer', async () => {
    const f = await createFixture()
    const image = join(f.workspace, 'unsafe.png')
    const file = join(f.workspace, 'unsafe.bin')
    await expect(f.service.registerGeneratedImages({ conversationId: 'conversation-1', cwd: f.workspace, grants: f.grants, outputPath: image, sourceArtifactId: null, images: [{ bytes: Uint8Array.of(1), mimeType: 'image/png' }] })).rejects.toMatchObject({ code: 'ARTIFACT_PUBLICATION_FAILED' })
    await expect(f.service.registerGeneratedFile({ conversationId: 'conversation-1', cwd: f.workspace, grants: f.grants, outputPath: file, bytes: Uint8Array.of(1), assertCurrent: () => {} })).rejects.toMatchObject({ code: 'ARTIFACT_PUBLICATION_FAILED' })
    await expect(readFile(image)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('materializes an agent image reference within current execution grants independently of the original publication grant', async () => {
    const fixture = await createFixture()
    const conversationGrants = createConversationDirectoryGrantRepository(fixture.database)
    conversationGrants.grant({ conversationId: 'conversation-1', id: 'workspace-1', root: fixture.workspace, canonicalRoot: fixture.workspace, createdAt: '2026-08-27T00:00:00.000Z' })
    const service = new ArtifactService({ repository: fixture.repository })
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
    await expect(service.materializeConversationImages('conversation-1', [artifact!.id], access)).resolves.toMatchObject({ images: [{ data: bytes.toString('base64') }] })
  })

  it('publishes an independent file with a long multibyte name and refuses revoked publication or overwrite', async () => {
    const f = await createFixture()
    const name = `${'文'.repeat(75)}.docx`
    const path = join(f.workspace, 'outputs', name)
    const bytes = Uint8Array.of(80, 75, 3, 4)
    const record = await f.service.registerGeneratedFile({ conversationId: 'conversation-1', cwd: f.workspace, grants: f.grants, outputPath: path, bytes, assertCurrent: () => {} }, f.writeFiles)
    bytes[0] = 0
    expect(await readFile(record.currentPath)).toEqual(Buffer.from([80, 75, 3, 4]))
    expect(f.repository.findById(record.id)).toMatchObject({ name, conversationId: 'conversation-1', sizeBytes: 4 })
    let current = true
    const revokeBeforeWrite: CapturedFileWriter = (paths, write) => f.writeFiles(paths, publish => write((input) => {
      current = false
      return publish(input)
    }))
    const revoked = join(f.workspace, 'outputs', 'revoked.docx')
    await expect(f.service.registerGeneratedFile({ conversationId: 'conversation-1', cwd: f.workspace, grants: f.grants, outputPath: revoked, bytes, assertCurrent: () => {
      if (!current)
        throw new Error('revoked')
    } }, revokeBeforeWrite)).rejects.toMatchObject({ receipt: { outcome: 'partial', written: 0, unconfirmedWrites: 1, artifactIds: [] } })
    await expect(readFile(revoked)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(f.repository.listForConversation('conversation-1')).toHaveLength(1)
    await expect(f.service.registerGeneratedFile({ conversationId: 'conversation-1', cwd: f.workspace, grants: f.grants, outputPath: path, bytes, assertCurrent: () => {} }, f.writeFiles)).rejects.toThrow()
    expect(await readFile(path)).toEqual(Buffer.from([80, 75, 3, 4]))
  })

  it('retains a partial receipt when native publication applies before its response is lost', async () => {
    const f = await createFixture()
    const path = join(f.workspace, 'applied.bin')
    const bytes = Uint8Array.of(0, 1, 2)
    const lostResponse: CapturedFileWriter = (paths, write) => f.writeFiles(paths, publish => write(async (input) => {
      await publish(input)
      throw new Error('PUBLICATION_RESPONSE_LOST')
    }))
    await expect(f.service.registerGeneratedFile({ conversationId: 'conversation-1', cwd: f.workspace, grants: f.grants, outputPath: path, bytes, assertCurrent: () => {} }, lostResponse)).rejects.toMatchObject({ receipt: { outcome: 'partial', written: 0, unconfirmedWrites: 1, artifactIds: [], stage: 'file' } })
    expect(await readFile(path)).toEqual(Buffer.from(bytes))
    expect(f.repository.listForConversation('conversation-1')).toEqual([])
  })

  it('opens the current file at the delivered path without accepting deleted owners', async () => {
    const fixture = await createFixture()
    const workspace = fixture.workspace
    const service = new ArtifactService({ repository: fixture.repository })
    const path = join(workspace, 'video.webm')
    await writeFile(path, 'media')
    const [artifact] = await service.presentOutputs({ conversationId: 'conversation-1', cwd: workspace, grants: [{ root: workspace, canonicalRoot: workspace, grantId: 'conversation-1', kind: 'workspace' }], paths: [path] })
    expect(await service.resolveMedia(artifact!.id)).toMatchObject({ path, mimeType: 'video/webm' })
    const outside = join(fixture.root, 'private.webm')
    await writeFile(outside, 'private')
    await rm(path)
    await symlink(outside, path)
    await expect(service.resolveMedia(artifact!.id)).rejects.toMatchObject({ code: 'FILE_CHANGED' })
    await expect(service.locate(artifact!.id)).rejects.toMatchObject({ code: 'FILE_CHANGED' })
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
    await expect(service.registerGeneratedImages({ conversationId: 'conversation-1', cwd: fixture.workspace, grants: fixture.grants, outputPath: 'result.png', sourceArtifactId: null, images: [{ bytes: Uint8Array.of(1), mimeType: 'image/png' }, { bytes: Uint8Array.of(2), mimeType: 'image/png' }] }, fixture.writeFiles)).rejects.toMatchObject({ receipt: { outcome: 'partial', written: 2, unconfirmedWrites: 0, stage: 'catalogue', artifactIds: [expect.any(String)] } })
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
    await expect(fixture.service.registerGeneratedImages({ conversationId: 'conversation-1', cwd: fixture.workspace, grants: fixture.grants, outputPath: 'result.png', sourceArtifactId: null, images: [{ bytes: Uint8Array.of(1), mimeType: 'image/png' }, { bytes: Uint8Array.of(2), mimeType: 'image/png' }] }, fixture.writeFiles)).rejects.toMatchObject({ receipt: { outcome: 'partial', written: 1, unconfirmedWrites: 1, artifactIds: [], stage: 'file' } })
    expect(await readFile(join(fixture.workspace, 'result.png'))).toEqual(Buffer.from([1]))
    expect(fixture.repository.listForConversation('conversation-1')).toEqual([])
  })

  it('isolates accepted bytes and grants and drains their publication before disposal', async () => {
    const fixture = await createFixture()
    const bytes = Uint8Array.of(1, 2, 3)
    const events: ArtifactEvent[] = []
    fixture.service.onDidChange(event => events.push(event))
    const pending = fixture.service.registerGeneratedImages({ conversationId: 'conversation-1', cwd: fixture.workspace, grants: fixture.grants, outputPath: 'result.png', sourceArtifactId: null, images: [{ bytes, mimeType: 'image/png' }] }, fixture.writeFiles)
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

  it('presents only explicitly selected, authorized files and directories as separate outputs', async () => {
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
    const sourcePath = join(fixture.root, 'outside.svg')
    await writeFile(sourcePath, '<svg></svg>')
    await expect(fixture.service.presentOutputs({
      conversationId: 'conversation-1',
      cwd: fixture.workspace,
      grants: fixture.grants,
      paths: [sourcePath],
    })).rejects.toMatchObject({ code: 'PATH_OUTSIDE_GRANTED_DIRECTORY' })
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
    }, fixture.writeFiles)

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
    }, fixture.writeFiles)

    expect(updated!.id).toBe(first[0]!.id)
    expect(updated!.sourceArtifactId).toBeNull()
    createConversationRepository(fixture.database).markDeleted(
      'conversation-1',
      '2026-08-27T00:00:00.000Z',
    )

    expect(fixture.repository.findVisibleById(updated!.id)).toBeNull()
    await expect(fixture.service.resolvePreview(updated!.id))
      .rejects
      .toMatchObject({ code: 'ARTIFACT_NOT_FOUND' })
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
  const publication = createArtifactPublicationFixture(root)
  publications.push(publication)
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
    writeFiles: publication.writeFiles,
    root,
    service: new ArtifactService({ repository }),
    workspace,
  }
}

function createArtifactPublicationFixture(root: string) {
  const signal = new AbortController().signal
  const engine = new NativeFileEngine(join(root, 'file-journal'))
  const files = new FileResourceCoordinator(engine)
  const mutations = new MutationCoordinator({ resources: files })
  const writeFiles: CapturedFileWriter = (paths, write) => files.withStagingDirectory(async (stagingDirectory) => {
    const claims = await files.fileWriteClaims(paths)
    const lease = await mutations.acquire({ runId: 'publication-test', invocationId: randomUUID(), lifetime: 'runtime', claims: [...claims, { kind: 'tree', canonicalPath: stagingDirectory }], signal })
    try {
      await write(input => files.writeFile(lease.invocationId, stagingDirectory, input, signal))
    }
    finally {
      await lease.release()
    }
  })
  return { writeFiles, async dispose() {
    await mutations.dispose()
    await engine.dispose()
  } }
}
