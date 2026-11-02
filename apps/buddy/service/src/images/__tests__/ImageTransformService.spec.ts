import type { DatabaseSync } from 'node:sqlite'
import type { CapturedFileWriter } from '../../changes/CapturedFileWriter'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ArtifactService } from '../../artifacts/ArtifactService'
import { MutationCoordinator } from '../../changes/MutationCoordinator'
import { FileResourceCoordinator } from '../../files/FileResourceCoordinator'
import { NativeFileEngine } from '../../files/NativeFileEngine'

import { createArtifactRepository } from '../../storage/artifactRepository'
import { createConversationRepository } from '../../storage/conversationRepository'
import { openBuddyDatabase } from '../../storage/database'
import { ImageTransformService } from '../ImageTransformService'
import { runNativeImage } from '../runNativeImage'

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

describe('imageTransformService', () => {
  it('removes a chroma background into a new PNG while preserving dimensions and lineage', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-image-transform-'))
    directories.push(root)
    const database = openBuddyDatabase({ databasePath: ':memory:' })
    databases.push(database)
    createConversationRepository(database).create({
      id: 'conversation-1',
      branchId: 'branch-1',
      spaceId: null,
      title: 'Conversation',
      approvalPolicy: 'policy',
      executionProfile: 'workspace_write',
      createdAt: '2026-08-31T00:00:00.000Z',
    })
    const publication = createArtifactPublicationFixture(root)
    publications.push(publication)
    const artifacts = new ArtifactService({ repository: createArtifactRepository(database) })
    const grants = [{ canonicalRoot: root, grantId: 'workspace-1', kind: 'workspace' as const, root }]
    const sourceBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAFElEQVR4AQEJAPb/AAD/AP//AAD/EPgD/UE7EkoAAAAASUVORK5CYII=', 'base64')
    const [source] = await artifacts.registerGeneratedImages({
      conversationId: 'conversation-1',
      cwd: root,
      grants,
      images: [{ bytes: sourceBytes, mimeType: 'image/png' }],
      outputPath: '绿幕.png',
      sourceArtifactId: null,
    }, publication.writeFiles)
    const service = new ImageTransformService({ artifacts })

    const transformed = await service.removeChroma({
      color: '#00ff00',
      conversationId: 'conversation-1',
      cwd: root,
      despill: 1,
      grants,
      outputPath: '透明头像.png',
      softness: 20,
      sourceArtifactId: source!.id,
      tolerance: 10,
    }, undefined, publication.writeFiles)

    expect(transformed).toMatchObject({
      mimeType: 'image/png',
      name: '透明头像.png',
      sourceArtifactId: source!.id,
    })
    const derived = await artifacts.materializeConversationArtifact(
      'conversation-1',
      transformed.id,
    )
    const metadata = await runNativeImage(derived.bytes, { operation: 'validate', options: { mimeType: 'image/png' } })
    expect(JSON.parse(Buffer.from(metadata).toString('utf8'))).toEqual({ width: 2, height: 1, mimeType: 'image/png' })
    const original = await artifacts.materializeConversationArtifact('conversation-1', source!.id)
    expect(Buffer.from(original.bytes)).toEqual(sourceBytes)
    expect(Buffer.from(derived.bytes)).not.toEqual(sourceBytes)
  })
})

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
