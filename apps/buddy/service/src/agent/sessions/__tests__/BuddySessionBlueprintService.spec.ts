import type { SpaceRecord } from '../../../storage/spaceRepository'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BuddyDataPaths } from '../../../storage/BuddyDataPaths'
import { toBuddySessionIdentity } from '../BuddySessionBlueprint'
import { BuddySessionBlueprintService } from '../BuddySessionBlueprintService'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { force: true, recursive: true })))
})

describe('buddySessionBlueprintService', () => {
  it('resolves a Space directory, grants and trusted resources as one session contract', async () => {
    const root = await createDirectory()
    const spaceRoot = join(root, 'space')
    await mkdir(spaceRoot)
    const space = createSpace(spaceRoot)
    const loadForSpace = vi.fn(async () => ({
      diagnostics: [],
      readRoots: [],
      references: [],
      paths: ['/skills/space/SKILL.md'],
      revision: 'skills-revision-1',
      skills: [],
    }))
    const paths = new BuddyDataPaths(join(root, 'buddy-home'))
    const service = new BuddySessionBlueprintService({
      conversationGrants: { listActive: () => [] },
      paths,
      skills: { loadForSpace },
      spaces: { findById: id => id === space.id ? space : null },
    })

    const blueprint = await service.createForConversation({
      branchId: 'branch-1',
      conversationId: 'conversation-1',
      approvalPolicy: 'policy' as const,
      executionProfile: 'workspace_write',
      sessionMode: 'interactive',
      spaceId: space.id,
    })
    const scratchRoot = await realpath(paths.spaceWorkspace('space-1'))

    expect(blueprint).toMatchObject({
      canonicalRoot: spaceRoot,
      grants: [
        { canonicalRoot: spaceRoot, grantId: 'directory-1', kind: 'workspace' as const, root: spaceRoot },
        { canonicalRoot: scratchRoot, grantId: 'space-1', kind: 'workspace' as const, root: scratchRoot },
      ],
      resources: { skillReadRoots: [], skillReferences: [], approvedSkills: [] },
      scratchRoot,
      space: {
        additionalDirectoryBindings: [],
        id: 'space-1',
        memoryScope: 'space_only',
        primaryDirectoryBinding: { id: 'directory-1', revision: 1 },
      },
    })
    expect(blueprint.resources.directoryContext).toContain(`Working directory: ${spaceRoot}`)
    expect(toBuddySessionIdentity(blueprint)).toEqual({
      branchId: 'branch-1',
      canonicalRoot: spaceRoot,
      conversationId: 'conversation-1',
      approvalPolicy: 'policy' as const,
      executionProfile: 'workspace_write',
      grantRevision: blueprint.grantRevision,
      resourceRevision: blueprint.resources.revision,
      scratchRoot,
      sessionMode: 'interactive',
      spaceId: 'space-1',
    })
    expect(loadForSpace).toHaveBeenCalledWith('space-1')
  })

  it('creates an owned conversation workspace and grant without a Space', async () => {
    const root = await createDirectory()
    await mkdir(join(root, 'outside'))
    const paths = new BuddyDataPaths(join(root, 'buddy-home'))
    const service = new BuddySessionBlueprintService({
      conversationGrants: {
        listActive: conversationId => conversationId === 'conversation-1'
          ? [{
              canonicalRoot: join(root, 'outside'),
              conversationId,
              createdAt: '2026-09-03T00:00:00.000Z',
              id: 'conversation-grant-1',
              revokedAt: null,
              root: join(root, 'outside'),
            }]
          : [],
      },
      paths,
      skills: {
        loadForSpace: async () => ({
          diagnostics: [],
          readRoots: [],
          references: [],
          paths: [],
          revision: 'skills-revision-1',
          skills: [],
        }),
      },
      spaces: { findById: () => null },
    })

    const blueprint = await service.createForConversation({
      branchId: 'branch-1',
      conversationId: 'conversation-1',
      approvalPolicy: 'policy' as const,
      executionProfile: 'full_access',
      sessionMode: 'interactive',
      spaceId: null,
    })

    expect(blueprint.canonicalRoot).toBe(await realpath(paths.conversationWorkspace('conversation-1')))
    expect(blueprint.scratchRoot).toBe(blueprint.canonicalRoot)
    expect(blueprint.grants).toEqual([
      {
        canonicalRoot: blueprint.canonicalRoot,
        grantId: 'conversation-1',
        kind: 'workspace' as const,
        root: blueprint.canonicalRoot,
      },
      {
        canonicalRoot: join(root, 'outside'),
        grantId: 'conversation-grant-1',
        kind: 'granted' as const,
        root: join(root, 'outside'),
      },
    ])
    expect(blueprint.space).toBeNull()
  })
})

function createSpace(root: string): SpaceRecord {
  const timestamp = '2026-08-28T00:00:00.000Z'
  return {
    activeRunCount: 0,
    icon: 'folder',
    iconColor: 'default',
    additionalDirectories: [],
    createdAt: timestamp,
    id: 'space-1',
    memoryScope: 'space_only',
    name: 'Space',
    primaryDirectory: {
      accessGrantedAt: timestamp,
      canonicalRoot: root,
      createdAt: timestamp,
      id: 'directory-1',
      resourcesTrustedAt: timestamp,
      revision: 1,
      revokedAt: null,
      root,
      spaceId: 'space-1',
      updatedAt: timestamp,
    },
    revokedAt: null,
    updatedAt: timestamp,
  }
}

async function createDirectory(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'buddy-session-blueprint-')))
  directories.push(root)
  return root
}
