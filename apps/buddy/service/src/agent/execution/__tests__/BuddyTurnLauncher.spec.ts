import type { DatabaseSync } from 'node:sqlite'
import type { SkillReference } from '../../../../../shared/skills/skillApi'
import type { RunRecord } from '../../../storage/runRecord'
import type {
  BuddyTurnHandle,
  StartBuddyTurnInput,
} from '../turnTypes'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRunEventLog } from '../../../events/createRunEventLog'
import { RunLifecycleService } from '../../../runs/RunLifecycleService'
import { SkillService } from '../../../skills/SkillService'
import { prepareTestTurnRequest } from '../../../storage/__tests__/composerDraftTestFixture'
import { BuddyDataPaths } from '../../../storage/BuddyDataPaths'
import { createCommandRequestRepository } from '../../../storage/commandRequestRepository'
import { createConversationRepository } from '../../../storage/conversationRepository'
import { openBuddyDatabase } from '../../../storage/database'
import { createRunInputRepository } from '../../../storage/runInputRepository'
import { createRunRepository } from '../../../storage/runRepository'
import { createSkillRepository } from '../../../storage/skillRepository'
import { createSpaceRepository } from '../../../storage/spaceRepository'
import { BuddySessionBlueprintService } from '../../sessions/BuddySessionBlueprintService'
import { BuddyRunExecutionPlanner } from '../BuddyRunExecutionPlanner'
import { BuddyTurnLauncher } from '../BuddyTurnLauncher'

const databases: DatabaseSync[] = []
const directories: string[] = []

afterEach(async () => {
  for (const database of databases.splice(0))
    database.close()
  await Promise.all(directories.splice(0).map(path => rm(path, { force: true, recursive: true })))
})

describe('buddyTurnLauncher', () => {
  it('rejects a saved Skill reference missing from the launch resource snapshot', async () => {
    const fixture = await createFixture({ selectedSkill: { id: 'writer-id', name: 'writer', revision: 'old' } })
    fixture.prepareTurn({ spaceId: null })
    await expect(fixture.planner.resolve('run-1')).rejects.toMatchObject({ code: 'SKILL_CHANGED' })
    expect(fixture.runs.findById('run-1')?.status).toBe('queued')
  })

  it.each(['legacy', 'current'] as const)('launches an unchanged %s Skill reference and rejects later package changes', async (format) => {
    const fixture = await createFixture()
    const directory = join(fixture.root, 'agent', 'skills', 'writer')
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'SKILL.md'), '---\nname: writer\ndescription: Write text\n---\nWrite carefully.')
    const resource = join(directory, 'reference.md')
    await writeFile(resource, 'first version')
    const [materialized] = await fixture.skills.materializeForSpace(null, ['writer'])
    const selectedSkill = format === 'legacy'
      ? { id: materialized!.reference.id, name: 'writer', revision: materialized!.reference.packageRevision! }
      : materialized!.reference
    fixture.prepareTurn({ spaceId: null, selectedSkill })

    const plan = await fixture.planner.resolve('run-1')
    expect(plan.kind).toBe('turn')
    expect(plan.input.session.resources.skillReferences).toContainEqual(expect.objectContaining({
      id: selectedSkill.id,
      revision: materialized!.reference.revision,
    }))
    await writeFile(resource, 'second version')
    await expect(fixture.planner.resolve('run-1')).rejects.toMatchObject({ code: 'SKILL_CHANGED' })
    expect(fixture.runs.findById('run-1')?.status).toBe('queued')
  })

  it('rebuilds the executable turn from persisted run facts', async () => {
    const fixture = await createFixture()
    fixture.prepareTurn({ spaceId: null })
    let launched: StartBuddyTurnInput | null = null
    const launcher = fixture.createLauncher({
      startTurn(input) {
        launched = input
        return queuedHandle(input.runId, fixture.runs.findById(input.runId)!)
      },
    })

    await expect(launcher.launch('run-1')).resolves.toMatchObject({ runId: 'run-1' })

    expect(launched).toMatchObject({
      serviceTier: 'priority',
      session: {
        branchId: 'branch-1',
        canonicalRoot: fixture.paths.conversationWorkspace('conversation-1'),
        conversationId: 'conversation-1',
        sessionMode: 'interactive',
      },
      thinkingLevel: 'high',
      userInput: {
        images: [{ attachmentId: 'attachment-1', mimeType: 'image/png' }],
        messageId: 'message-1',
        prompt: 'Persisted prompt',
        version: 1,
      },
    })
    expect(fixture.resolveInputReferences).toHaveBeenCalledWith(
      ['attachment-1'],
      'conversation-1',
      'Persisted prompt',
    )
  })

  it('durably fails a queued run when its Space directory was revoked before launch', async () => {
    const fixture = await createFixture()
    fixture.spaces.create(spaceInput('space-1', fixture.root))
    fixture.prepareTurn({ spaceId: 'space-1' })
    fixture.spaces.delete('space-1', '2026-08-28T00:01:00.000Z', {
      createdAt: '2026-08-28T00:01:00.000Z',
      eventType: 'space.deleted',
      id: 'space-event-1',
      payload: {},
      spaceId: 'space-1',
    })
    const startTurn = vi.fn()
    const launcher = fixture.createLauncher({ startTurn })

    const handle = await launcher.launch('run-1')

    await expect(handle.completion).resolves.toMatchObject({
      errorCode: 'AGENT_RUN_FAILED',
      status: 'failed',
    })
    expect(startTurn).not.toHaveBeenCalled()
    expect((await fixture.eventLog.read('run-1')).map(event => event.type))
      .toEqual(['run.failed'])
  })

  it('rejects a Space root that resolves to a different directory at launch', async () => {
    const fixture = await createFixture()
    const authorizedRoot = join(fixture.root, 'authorized')
    const replacementRoot = join(fixture.root, 'replacement')
    const grantedPath = join(fixture.root, 'space')
    await Promise.all([
      mkdir(authorizedRoot),
      mkdir(replacementRoot),
    ])
    await symlink(authorizedRoot, grantedPath, 'dir')
    fixture.spaces.create(spaceInput('space-1', grantedPath, authorizedRoot))
    fixture.prepareTurn({ spaceId: 'space-1' })
    await rm(grantedPath)
    await symlink(replacementRoot, grantedPath, 'dir')
    const startTurn = vi.fn()
    const launcher = fixture.createLauncher({ startTurn })

    const handle = await launcher.launch('run-1')

    await expect(handle.completion).resolves.toMatchObject({
      errorCode: 'DIRECTORY_NOT_AUTHORIZED',
      status: 'failed',
    })
    expect(startTurn).not.toHaveBeenCalled()
  })

  it('keeps stable image references when launching a text-only model', async () => {
    const fixture = await createFixture({ modelInput: ['text'] })
    fixture.prepareTurn({ spaceId: null })
    let launched: StartBuddyTurnInput | null = null
    const launcher = fixture.createLauncher({ startTurn(input) {
      launched = input
      return queuedHandle(input.runId, fixture.runs.findById(input.runId)!)
    } })
    await expect(launcher.launch('run-1')).resolves.toMatchObject({ runId: 'run-1' })
    expect(launched).toMatchObject({ userInput: { attachmentIds: ['attachment-1'], images: [{ attachmentId: 'attachment-1', mimeType: 'image/png' }] } })
  })

  it('durably fails a queued run when the runner rejects it synchronously', async () => {
    const fixture = await createFixture()
    fixture.prepareTurn({ spaceId: null })
    const launcher = fixture.createLauncher({
      startTurn() {
        throw new Error('runner rejected launch')
      },
    })

    const handle = await launcher.launch('run-1')

    await expect(handle.completion).resolves.toMatchObject({
      errorCode: 'AGENT_RUN_FAILED',
      status: 'failed',
    })
    expect((await fixture.eventLog.read('run-1')).map(event => event.type))
      .toEqual(['run.failed'])
  })
})

async function createFixture(options: { modelInput?: readonly ('text' | 'image')[], selectedSkill?: SkillReference } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'lexora-buddy-launcher-')))
  directories.push(root)
  await mkdir(root, { recursive: true })
  const database = openBuddyDatabase({ databasePath: ':memory:' })
  databases.push(database)
  const paths = new BuddyDataPaths(root)
  const spaces = createSpaceRepository(database)
  const runs = createRunRepository(database)
  const resolveInputReferences = vi.fn(async () => ({
    images: [{ attachmentId: 'attachment-1', mimeType: 'image/png' }],
    documents: [],
  }))
  const eventLog = createRunEventLog({
    conversationsDirectory: paths.conversationsDirectory,
    database,
  })
  const lifecycle = new RunLifecycleService({ eventLog, repository: runs })
  const skills = new SkillService({
    agentDirectory: join(root, 'agent'),
    paths,
    repository: createSkillRepository(database),
    spaces,
  })
  const blueprints = new BuddySessionBlueprintService({
    conversationGrants: { listActive: () => [] },
    paths,
    skills,
    spaces,
  })
  const planner = new BuddyRunExecutionPlanner({
    attachments: { resolveInputReferences },
    commands: createCommandRequestRepository(database),
    conversations: createConversationRepository(database),
    models: { resolveAvailable: async () => ({ input: options.modelInput ?? ['text', 'image'] }) as never },
    runInputs: createRunInputRepository(database),
    runs,
    sessions: blueprints,
    skills,
  })
  return {
    createLauncher(overrides: {
      startTurn?: (input: StartBuddyTurnInput) => BuddyTurnHandle
    } = {}) {
      return new BuddyTurnLauncher({
        lifecycle,
        planner,
        runner: {
          startCompaction() {
            throw new Error('Unexpected compaction launch')
          },
          startTurn: overrides.startTurn ?? (() => {
            throw new Error('Unexpected turn launch')
          }),
        },
      })
    },
    eventLog,
    planner,
    resolveInputReferences,
    paths,
    skills,
    prepareTurn({ spaceId, selectedSkill = options.selectedSkill }: { spaceId: string | null, selectedSkill?: SkillReference }) {
      prepareTestTurnRequest(database, {
        attachmentBindings: [],
        branchId: 'branch-1',
        conversationId: 'conversation-1',
        createdAt: '2026-08-28T00:00:00.000Z',
        approvalPolicy: 'policy' as const,
        executionProfile: 'workspace_write',
        model: 'persisted-model',
        modelParameters: { contextWindow: 128_000, maxTokens: 16_384 },
        spaceId,
        provider: 'persisted-provider',
        requestFingerprint: 'request-fingerprint-1',
        requestId: 'request-1',
        runId: 'run-1',
        runInput: {
          attachmentIds: [],
          contextItems: selectedSkill ? [{ kind: 'skill', value: selectedSkill.name, skill: selectedSkill }] : [],
          prompt: 'Persisted prompt',
          reasoning: 'high',
          serviceTier: 'priority',
        },
        title: 'Conversation',
        userMessageContent: { text: 'Original UI input' },
        userMessageId: 'message-1',
      })
      database.prepare(`
        UPDATE run_inputs SET attachment_ids_json = ? WHERE run_id = ?
      `).run(JSON.stringify(['attachment-1']), 'run-1')
    },
    root,
    runs,
    spaces,
  }
}

function spaceInput(id: string, root: string, canonicalRoot = root) {
  const createdAt = '2026-08-28T00:00:00.000Z'
  return {
    additionalDirectories: [],
    createdAt,
    id,
    memoryScope: 'space_only' as const,
    name: 'Space',
    primaryDirectory: {
      accessGrantedAt: createdAt,
      canonicalRoot,
      id: `directory-${id}`,
      resourcesTrustedAt: createdAt,
      root,
    },
  }
}

function queuedHandle(
  runId: string,
  run: RunRecord,
): BuddyTurnHandle {
  return { completion: Promise.resolve(run), runId }
}
