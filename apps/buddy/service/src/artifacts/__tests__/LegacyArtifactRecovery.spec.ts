import type { DatabaseSync } from 'node:sqlite'
import type { ArtifactEvent } from '../ArtifactService'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import { createArtifactRepository } from '../../storage/artifactRepository'
import { BuddyDataPaths } from '../../storage/BuddyDataPaths'
import { createConversationRepository } from '../../storage/conversationRepository'
import { openBuddyDatabase } from '../../storage/database'
import { ArtifactService } from '../ArtifactService'
import { reconcileLegacyArtifactOutputs } from '../LegacyArtifactRecovery'

const databases: DatabaseSync[] = []
const directories: string[] = []

afterEach(async () => {
  databases.splice(0).forEach(database => database.close())
  await Promise.all(directories.splice(0).map(path => rm(path, { force: true, recursive: true })))
})

describe('legacy artifact output recovery', () => {
  it('reconnects one-to-one legacy output events with the files that still exist', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lexora-buddy-legacy-artifacts-'))
    directories.push(root)
    const paths = new BuddyDataPaths(root)
    const database = openBuddyDatabase({ databasePath: ':memory:' })
    databases.push(database)
    const conversations = createConversationRepository(database)
    conversations.create({
      approvalPolicy: 'policy',
      branchId: 'branch-1',
      createdAt: '2026-09-04T00:00:00.000Z',
      executionProfile: 'workspace_write',
      id: 'conversation-1',
      spaceId: null,
      title: 'Legacy output',
    })
    const directory = paths.conversationArtifactsDirectory('conversation-1')
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'first.png'), Uint8Array.of(1, 2, 3))
    await writeFile(join(directory, 'second.html'), '<h1>Recovered</h1>')
    const repository = createArtifactRepository(database)
    let failNext = true
    const events: ArtifactEvent[] = []
    const catalogue = new ArtifactService({ repository: { ...repository, save(record) {
      if (record.id === 'artifact-file' && failNext) {
        failNext = false
        throw new Error('catalogue unavailable')
      }
      return repository.save(record)
    } } })
    catalogue.onDidChange(event => events.push(event))
    const eventLog = {
      listForConversation: () => [{
        createdAt: '2026-09-04T00:00:01.000Z',
        payload: {
          artifactIds: ['artifact-image'],
          sourceToolCallId: 'tool-image',
          sourceToolName: 'lexora_image_generate',
        },
        runId: 'run-1',
        sequence: 1,
        type: 'output.produced',
      }, {
        createdAt: '2026-09-04T00:00:02.000Z',
        payload: {
          artifactIds: ['artifact-file'],
          sourceToolCallId: 'tool-file',
          sourceToolName: 'lexora_artifact_present',
        },
        runId: 'run-2',
        sequence: 1,
        type: 'output.produced',
      }],
    }

    await expect(reconcileLegacyArtifactOutputs({ artifacts: repository, catalogue, conversations, eventLog, paths })).rejects.toMatchObject({ receipt: { cause: 'recovery', outcome: 'partial', artifactIds: ['artifact-image'], written: 0 } })
    expect(repository.findById('artifact-image')).not.toBeNull()
    expect(repository.findById('artifact-file')).toBeNull()
    await expect(reconcileLegacyArtifactOutputs({ artifacts: repository, catalogue, conversations, eventLog, paths })).resolves.toBe(1)
    expect(events.filter(event => event.kind === 'catalogue-committed').map(event => event.artifactId)).toEqual(['artifact-image', 'artifact-file'])
    expect(events.every(event => event.receipt.cause === 'recovery')).toBe(true)
    expect(repository.findById('artifact-image')).toMatchObject({
      currentPath: join(directory, 'first.png'),
      mimeType: 'image/png',
    })
    expect(repository.findById('artifact-file')).toMatchObject({
      currentPath: join(directory, 'second.html'),
      mimeType: 'text/html',
    })
    await expect(reconcileLegacyArtifactOutputs({
      artifacts: repository,
      catalogue: new ArtifactService({ repository }),
      conversations,
      eventLog,
      paths,
    })).resolves.toBe(0)
  })

  it('keeps ambiguous legacy output unindexed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lexora-buddy-legacy-artifacts-'))
    directories.push(root)
    const paths = new BuddyDataPaths(root)
    const database = openBuddyDatabase({ databasePath: ':memory:' })
    databases.push(database)
    const conversations = createConversationRepository(database)
    conversations.create({
      approvalPolicy: 'policy',
      branchId: 'branch-1',
      createdAt: '2026-09-04T00:00:00.000Z',
      executionProfile: 'workspace_write',
      id: 'conversation-1',
      spaceId: null,
      title: 'Ambiguous legacy output',
    })
    const directory = paths.conversationArtifactsDirectory('conversation-1')
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'only.png'), Uint8Array.of(1, 2, 3))
    const repository = createArtifactRepository(database)

    await expect(reconcileLegacyArtifactOutputs({
      artifacts: repository,
      catalogue: new ArtifactService({ repository }),
      conversations,
      eventLog: {
        listForConversation: () => [{
          createdAt: '2026-09-04T00:00:01.000Z',
          payload: {
            artifactIds: ['artifact-first', 'artifact-second'],
            sourceToolCallId: 'tool-image',
            sourceToolName: 'lexora_image_generate',
          },
          runId: 'run-1',
          sequence: 1,
          type: 'output.produced',
        }],
      },
      paths,
    })).resolves.toBe(0)
    expect(repository.findById('artifact-first')).toBeNull()
    expect(repository.findById('artifact-second')).toBeNull()
  })
})
