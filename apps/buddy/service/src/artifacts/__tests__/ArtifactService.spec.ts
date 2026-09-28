import type { DatabaseSync } from 'node:sqlite'
import type { DirectoryGrant } from '../../directories/resolveGrantedPath'
import type { ArtifactEvent } from '../ArtifactService'
import { Buffer } from 'node:buffer'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import { prepareTestTurnRequest } from '../../storage/__tests__/composerDraftTestFixture'
import { createArtifactRepository } from '../../storage/artifactRepository'
import { createConversationRepository } from '../../storage/conversationRepository'
import { openBuddyDatabase } from '../../storage/database'
import { ArtifactService } from '../ArtifactService'

const databases: DatabaseSync[] = []
const directories: string[] = []

afterEach(async () => {
  for (const database of databases.splice(0))
    database.close()
  await Promise.all(directories.splice(0).map(path => rm(path, { force: true, recursive: true })))
})

describe('artifactService', () => {
  it('retains written files and committed catalogue rows when a later row fails', async () => {
    const fixture = await createFixture()
    let saves = 0
    let listenerFailures = 0
    const service = new ArtifactService({ repository: { ...fixture.repository, save(record) {
      if (++saves === 2)
        throw new Error('private storage detail')
      return fixture.repository.save(record)
    } }, onListenerError: () => listenerFailures++ })
    const events: ArtifactEvent[] = []
    service.onDidChange(() => {
      throw new Error('observer detail')
    })
    service.onDidChange(event => events.push(event))
    await expect(service.registerGeneratedImages({ conversationId: 'conversation-1', cwd: fixture.workspace, grants: fixture.grants, outputPath: 'result.png', sourceArtifactId: null, images: [{ bytes: Uint8Array.of(1), mimeType: 'image/png' }, { bytes: Uint8Array.of(2), mimeType: 'image/png' }] })).rejects.toMatchObject({ receipt: { outcome: 'partial', written: 2, unconfirmedWrites: 0, stage: 'catalogue', artifactIds: [expect.any(String)] } })
    expect(events.map(event => event.kind)).toEqual(['file-written', 'file-written', 'catalogue-committed', 'batch-settled'])
    expect(events.map(event => event.revision)).toEqual([1, 2, 3, 4])
    expect(listenerFailures).toBe(4)
    const receipt = events.at(-1)!.receipt
    expect(Object.isFrozen(receipt.artifactIds)).toBe(true)
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

  it('presents explicitly selected files and directories without inferring their contents', async () => {
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

  it.each(['report.md', 'REPORT.MD', 'report.markdown'])('reads %s as Markdown without changing the file', async (name) => {
    const fixture = await createFixture()
    const path = join(fixture.workspace, name)
    const text = '# Route plan\n\n| Stop | Distance |\n| --- | --- |\n| Riverside | 20 km |\n'
    await writeFile(path, text)
    const [artifact] = await fixture.service.presentOutputs({
      conversationId: 'conversation-1',
      cwd: fixture.workspace,
      grants: fixture.grants,
      paths: [path],
    })
    expect(artifact!.mimeType).toBe('text/markdown')
    await expect(fixture.service.readText(artifact!.id)).resolves.toEqual({ artifactId: artifact!.id, language: 'markdown', text })
    fixture.database.prepare('UPDATE artifacts SET mime_type = ? WHERE id = ?').run('application/octet-stream', artifact!.id)
    await expect(fixture.service.readText(artifact!.id)).resolves.toEqual({ artifactId: artifact!.id, language: 'markdown', text })
    expect(fixture.repository.findVisibleById(artifact!.id)?.mimeType).toBe('application/octet-stream')
    await expect(readFile(path, 'utf8')).resolves.toBe(text)
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

  it('opens a presented HTML entry with its granted workspace root', async () => {
    const fixture = await createFixture()
    const entryPath = join(fixture.workspace, 'site', 'index.html')
    await mkdir(join(fixture.workspace, 'site'))
    await writeFile(entryPath, '<script src="app.js"></script>')
    await writeFile(join(fixture.workspace, 'site', 'app.js'), 'console.log("ready")')
    const [artifact] = await fixture.service.presentOutputs({
      conversationId: 'conversation-1',
      cwd: fixture.workspace,
      grants: fixture.grants,
      paths: [entryPath],
    })

    await expect(fixture.service.resolveBrowserEntry(
      'conversation-1',
      artifact!.id,
    )).resolves.toEqual({
      entryPath,
      rootPath: fixture.workspace,
    })
  })

  it('writes generated images and presents each generated file', async () => {
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
  })

  it('hides artifacts with a deleted conversation without deleting workspace files', async () => {
    const fixture = await createFixture()
    const [artifact] = await fixture.service.registerGeneratedImages({
      conversationId: 'conversation-1',
      cwd: fixture.workspace,
      grants: fixture.grants,
      images: [{ bytes: Uint8Array.from([7, 8, 9]), mimeType: 'image/png' }],
      outputPath: 'image.png',
      sourceArtifactId: null,
    })

    expect(fixture.repository.findVisibleById(artifact!.id)).not.toBeNull()
    createConversationRepository(fixture.database).markDeleted(
      'conversation-1',
      '2026-08-27T00:00:00.000Z',
    )

    expect(fixture.repository.findVisibleById(artifact!.id)).toBeNull()
    expect(() => fixture.service.resolvePreview(artifact!.id))
      .toThrow(/artifact operation failed/i)
    await expect(readFile(join(fixture.workspace, 'image.png')))
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
  seedRun(database)
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

function seedRun(database: DatabaseSync): void {
  prepareTestTurnRequest(database, {
    attachmentBindings: [],
    branchId: 'branch-1',
    conversationId: 'conversation-1',
    createdAt: '2026-08-27T00:00:00.000Z',
    approvalPolicy: 'policy' as const,
    executionProfile: 'workspace_write',
    model: 'model-1',
    provider: 'provider-1',
    requestFingerprint: 'fingerprint-1',
    requestId: 'request-1',
    runId: 'run-1',
    runInput: {
      attachmentIds: [],
      contextItems: [],
      prompt: 'hello',
      reasoning: null,
      serviceTier: null,
    },
    spaceId: null,
    title: 'Conversation',
    userMessageContent: { attachmentIds: [], text: 'hello' },
    userMessageId: 'message-1',
  })
}
