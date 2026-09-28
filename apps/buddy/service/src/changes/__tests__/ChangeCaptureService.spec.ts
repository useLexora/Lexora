import type { DatabaseSync } from 'node:sqlite'
import type { ChangeCaptureEvent } from '../ChangeCaptureService'
import { mkdir, mkdtemp, open, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { prepareTestTurnRequest } from '../../storage/__tests__/composerDraftTestFixture'
import { BuddyDataPaths } from '../../storage/BuddyDataPaths'
import { openBuddyDatabase } from '../../storage/database'
import { ChangeCaptureService } from '../ChangeCaptureService'
import { createChangeSetRepository } from '../changeSetRepository'

const databases: DatabaseSync[] = []
const directories: string[] = []

afterEach(async () => {
  for (const database of databases.splice(0))
    database.close()
  await Promise.all(directories.splice(0).map(path => rm(path, { force: true, recursive: true })))
})

describe('changeCaptureService', () => {
  it('reports a committed capture even when count and partial coverage cannot be persisted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-change-receipts-'))
    directories.push(root)
    const workspace = join(root, 'workspace')
    await mkdir(workspace)
    const path = join(workspace, 'private.txt')
    await writeFile(path, 'private before')
    const database = openBuddyDatabase({ databasePath: ':memory:' })
    databases.push(database)
    seedRun(database)
    const repository = createChangeSetRepository(database)
    let failing = true
    const service = new ChangeCaptureService({ paths: new BuddyDataPaths(root), onListenerError: () => {}, repository: { ...repository, updateFileCount(...args) {
      if (failing)
        throw new Error('count failed')

      return repository.updateFileCount(...args)
    }, markPartial(...args) {
      if (failing)
        throw new Error('coverage failed')

      return repository.markPartial(...args)
    } } })
    const events: ChangeCaptureEvent[] = []
    service.onDidChange(() => {
      throw new Error('observer failed')
    })
    service.onDidChange(event => events.push(event))
    const input = { conversationId: 'conversation-1', runId: 'run-1', toolCallId: 'tool-1', toolName: 'edit' as const, cwd: workspace, grants: [{ root: workspace, canonicalRoot: workspace, grantId: 'grant-1', kind: 'workspace' as const }] }
    await service.beginFileTool({ ...input, arguments: { path } })
    await writeFile(path, 'private after')
    await expect(service.finishFileTool({ ...input, isError: false })).rejects.toThrow('count failed')
    expect(repository.listCaptures(input.runId)[0]?.status).toBe('completed')
    await expect(service.markPartial(input)).rejects.toMatchObject({ code: 'CHANGE_COVERAGE_UNCONFIRMED' })
    expect(repository.findSetById(input.runId)?.coverage).toBe('complete')
    expect(events.map(event => event.kind)).toEqual(['set-created', 'capture-committed', 'capture-committed', 'operation-failed', 'coverage-unconfirmed'])
    failing = false
    await service.finishFileTool({ ...input, isError: false })
    await service.markPartial(input)
    await service.markPartial(input)
    await service.finalizeRun(input.runId)
    await service.finalizeRun(input.runId)
    expect(events.filter(event => event.phase === 'after')).toHaveLength(1)
    expect(events.filter(event => event.kind === 'coverage-changed')).toHaveLength(1)
    expect(events.filter(event => event.kind === 'finalized')).toHaveLength(1)
    expect(await service.getVisibleDetail(input.runId)).toMatchObject({ coverage: 'partial', fileCount: 1, status: 'completed', files: [{ beforeText: 'private before', afterText: 'private after' }] })
    expect(JSON.stringify(events)).not.toContain(workspace)
    expect(JSON.stringify(events)).not.toContain('private')
    await service.dispose()
  })

  it('serializes an accepted workspace snapshot before finalization and drains both at shutdown', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-change-drain-'))
    directories.push(root)
    const workspace = join(root, 'workspace')
    await mkdir(workspace)
    await writeFile(join(workspace, 'private.txt'), 'private')
    const database = openBuddyDatabase({ databasePath: ':memory:' })
    databases.push(database)
    seedRun(database)
    const repository = createChangeSetRepository(database)
    const service = new ChangeCaptureService({ paths: new BuddyDataPaths(root), repository })
    const events: ChangeCaptureEvent[] = []
    service.onDidChange(event => events.push(event))
    const input = { conversationId: 'conversation-1', runId: 'run-1', toolCallId: 'shell-1', cwd: workspace, grants: [{ root: workspace, canonicalRoot: workspace, grantId: 'grant-1', kind: 'workspace' as const }] }
    const before = service.beginWorkspaceTool(input)
    input.grants.length = 0
    const finalized = service.finalizeRun(input.runId)
    const disposed = service.dispose()
    await Promise.all([before, finalized, disposed])
    expect(repository.findSetById(input.runId)).toMatchObject({ coverage: 'partial', status: 'completed' })
    expect(events.map(event => event.kind)).toEqual(['set-created', 'coverage-changed', 'finalized'])
    expect(events.map(event => event.revision)).toEqual([1, 2, 3])
    expect(events.every(event => Object.isFrozen(event))).toBe(true)
    await expect(service.beginWorkspaceTool(input)).rejects.toThrow('CHANGE_CAPTURE_STOPPED')
  })

  it('finishes the original capture scope after temporary permissions are revoked', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-expired-change-'))
    directories.push(root)
    const workspace = join(root, 'workspace')
    await mkdir(workspace)
    await writeFile(join(workspace, 'untouched.txt'), 'preserved')
    await writeFile(join(workspace, 'changed.txt'), 'before')
    const database = openBuddyDatabase({ databasePath: ':memory:' })
    databases.push(database)
    seedRun(database)
    const service = new ChangeCaptureService({ paths: new BuddyDataPaths(root), repository: createChangeSetRepository(database) })
    const input = { cwd: workspace, conversationId: 'conversation-1', runId: 'run-1', toolCallId: 'shell-expired', grants: [{ root: workspace, canonicalRoot: workspace, grantId: 'temporary', kind: 'granted' as const }] }
    await service.beginWorkspaceTool(input)
    await writeFile(join(workspace, 'changed.txt'), 'after')
    await service.finishWorkspaceTool({ ...input, grants: [], isError: true, toolName: 'bash' })
    await service.finalizeRun(input.runId)
    expect(await service.getVisibleDetail(input.runId)).toMatchObject({
      fileCount: 1,
      files: [{ changeType: 'modified', path: 'changed.txt', beforeText: 'before', afterText: 'after' }],
    })
  })

  it('does not report a skipped oversized file as deleted after a partial scan', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-partial-change-'))
    directories.push(root)
    const workspace = join(root, 'workspace')
    await mkdir(workspace)
    const path = join(workspace, 'growing.txt')
    await writeFile(path, 'before')
    const database = openBuddyDatabase({ databasePath: ':memory:' })
    databases.push(database)
    seedRun(database)
    const service = new ChangeCaptureService({ paths: new BuddyDataPaths(root), repository: createChangeSetRepository(database) })
    const input = { cwd: workspace, conversationId: 'conversation-1', runId: 'run-1', toolCallId: 'shell-partial', grants: [{ root: workspace, canonicalRoot: workspace, grantId: 'workspace', kind: 'workspace' as const }] }
    await service.beginWorkspaceTool(input)
    const file = await open(path, 'r+')
    try {
      await file.truncate(33 * 1024 * 1024)
    }
    finally {
      await file.close()
    }
    expect(await service.finishWorkspaceTool({ ...input, isError: false, toolName: 'bash' })).toEqual({ complete: false })
    await service.markPartial(input)
    await service.finalizeRun(input.runId)
    expect(await service.getVisibleDetail(input.runId)).toMatchObject({ coverage: 'partial', files: [], fileCount: 0 })
  })

  it('records every actual file-tool change in the run ChangeSet', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lexora-buddy-changes-created-'))
    directories.push(root)
    const workspace = join(root, 'workspace')
    await mkdir(workspace)
    const grants = [{ canonicalRoot: workspace, grantId: 'directory-1', kind: 'workspace' as const, root: workspace }]
    const createdPath = join(workspace, 'hello-world.html')
    const existingPath = join(workspace, 'existing.html')
    await writeFile(existingPath, '<p>before</p>')
    const database = openBuddyDatabase({ databasePath: ':memory:' })
    databases.push(database)
    seedRun(database)
    const service = new ChangeCaptureService({
      paths: new BuddyDataPaths(root),
      repository: createChangeSetRepository(database),
    })

    await service.beginFileTool({
      arguments: { path: createdPath },
      conversationId: 'conversation-1',
      cwd: workspace,
      grants,
      runId: 'run-1',
      toolCallId: 'tool-created',
      toolName: 'write',
    })
    await writeFile(createdPath, '<h1>Hello World</h1>')
    await expect(service.finishFileTool({
      conversationId: 'conversation-1',
      cwd: workspace,
      grants,
      isError: false,
      runId: 'run-1',
      toolCallId: 'tool-created',
      toolName: 'write',
    })).resolves.toBeUndefined()

    await service.beginFileTool({
      arguments: { path: existingPath },
      conversationId: 'conversation-1',
      cwd: workspace,
      grants,
      runId: 'run-1',
      toolCallId: 'tool-existing',
      toolName: 'write',
    })
    await writeFile(existingPath, '<p>after</p>')
    await expect(service.finishFileTool({
      conversationId: 'conversation-1',
      cwd: workspace,
      grants,
      isError: false,
      runId: 'run-1',
      toolCallId: 'tool-existing',
      toolName: 'write',
    })).resolves.toBeUndefined()
  })

  it('discovers nested shell changes and retains unambiguous moves', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lexora-buddy-changes-shell-'))
    directories.push(root)
    const workspace = join(root, 'workspace')
    await mkdir(workspace)
    const grants = [{ canonicalRoot: workspace, grantId: 'directory-1', kind: 'workspace' as const, root: workspace }]
    const changedPath = join(workspace, 'change.txt')
    const removedPath = join(workspace, 'remove.txt')
    const movedFromPath = join(workspace, 'old-name.txt')
    const movedToPath = join(workspace, 'renamed.txt')
    const createdPath = join(workspace, 'site', 'src', 'index.html')
    await writeFile(changedPath, 'before change')
    await writeFile(removedPath, 'remove me')
    await writeFile(movedFromPath, 'unique move content')
    const database = openBuddyDatabase({ databasePath: ':memory:' })
    databases.push(database)
    seedRun(database)
    const service = new ChangeCaptureService({
      paths: new BuddyDataPaths(root),
      repository: createChangeSetRepository(database),
    })

    await service.beginWorkspaceTool({
      conversationId: 'conversation-1',
      cwd: workspace,
      grants,
      runId: 'run-1',
      toolCallId: 'tool-shell',
    })
    await mkdir(join(workspace, 'site', 'src'), { recursive: true })
    await writeFile(createdPath, '<h1>Hello</h1>')
    await writeFile(changedPath, 'after change')
    await unlink(removedPath)
    await rename(movedFromPath, movedToPath)

    await expect(service.finishWorkspaceTool({
      conversationId: 'conversation-1',
      cwd: workspace,
      grants,
      isError: false,
      runId: 'run-1',
      toolCallId: 'tool-shell',
      toolName: 'bash',
    })).resolves.toEqual({
      complete: true,
    })
    await service.finalizeRun('run-1')

    expect(service.listSummariesForRuns(['run-1'])).toMatchObject([{
      coverage: 'complete',
      fileCount: 5,
      status: 'completed',
    }])
    await expect(service.getVisibleDetail('run-1')).resolves.toMatchObject({
      files: expect.arrayContaining([
        expect.objectContaining({ changeType: 'modified', path: 'change.txt' }),
        expect.objectContaining({ changeType: 'deleted', path: 'old-name.txt' }),
        expect.objectContaining({ changeType: 'deleted', path: 'remove.txt' }),
        expect.objectContaining({ changeType: 'created', path: 'renamed.txt' }),
        expect.objectContaining({ changeType: 'created', path: 'site/src/index.html' }),
      ]),
    })
  })

  it('aggregates repeated writes into one run-scoped before and after diff', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lexora-buddy-changes-'))
    directories.push(root)
    const workspace = join(root, 'workspace')
    await mkdir(workspace)
    const grants = [{ canonicalRoot: workspace, grantId: 'directory-1', kind: 'workspace' as const, root: workspace }]
    const path = join(workspace, 'hello.ts')
    await writeFile(path, 'export const greeting = "before"\n')
    const database = openBuddyDatabase({ databasePath: ':memory:' })
    databases.push(database)
    seedRun(database)
    const service = new ChangeCaptureService({
      paths: new BuddyDataPaths(root),
      repository: createChangeSetRepository(database),
    })

    await service.beginFileTool({
      arguments: { path },
      conversationId: 'conversation-1',
      cwd: workspace,
      grants,
      runId: 'run-1',
      toolCallId: 'tool-1',
      toolName: 'write',
    })
    await writeFile(path, 'export const greeting = "middle"\n')
    await service.finishFileTool({
      conversationId: 'conversation-1',
      cwd: workspace,
      grants,
      isError: false,
      runId: 'run-1',
      toolCallId: 'tool-1',
      toolName: 'write',
    })
    await service.beginFileTool({
      arguments: { path },
      conversationId: 'conversation-1',
      cwd: workspace,
      grants,
      runId: 'run-1',
      toolCallId: 'tool-2',
      toolName: 'edit',
    })
    await writeFile(path, 'export const greeting = "after"\n')
    await service.finishFileTool({
      conversationId: 'conversation-1',
      cwd: workspace,
      grants,
      isError: false,
      runId: 'run-1',
      toolCallId: 'tool-2',
      toolName: 'edit',
    })
    await service.finalizeRun('run-1')

    expect(service.listSummariesForRuns(['run-1'])).toEqual([{
      changeSetId: 'run-1',
      conversationId: 'conversation-1',
      coverage: 'complete',
      fileCount: 1,
      runId: 'run-1',
      status: 'completed',
      updatedAt: expect.any(String),
    }])
    await expect(service.getVisibleDetail('run-1')).resolves.toMatchObject({
      changeSetId: 'run-1',
      files: [{
        afterText: 'export const greeting = "after"\n',
        beforeText: 'export const greeting = "before"\n',
        changeType: 'modified',
        path: 'hello.ts',
        preview: 'text',
      }],
    })
  })

  it('aggregates only the requested runs and drops net-zero changes across turns', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-branch-changes-'))
    directories.push(root)
    const workspace = join(root, 'workspace')
    await mkdir(workspace)
    const path = join(workspace, 'value.txt')
    await writeFile(path, 'initial')
    const database = openBuddyDatabase({ databasePath: ':memory:' })
    databases.push(database)
    const service = new ChangeCaptureService({ paths: new BuddyDataPaths(root), repository: createChangeSetRepository(database) })
    for (const [index, text] of ['middle', 'final', 'initial'].entries()) {
      seedRun(database, index + 1)
      const input = { conversationId: 'conversation-1', cwd: workspace, runId: `run-${index + 1}`, toolCallId: `tool-${index}`, toolName: 'write' as const, grants: [{ root: workspace, canonicalRoot: workspace, grantId: 'workspace', kind: 'workspace' as const }] }
      await service.beginFileTool({ ...input, arguments: { path } })
      await writeFile(path, text)
      await service.finishFileTool({ ...input, isError: false })
      await service.finalizeRun(input.runId)
      database.prepare('UPDATE runs SET status = \'completed\' WHERE id = ?').run(input.runId)
    }
    expect(await service.getForRuns(['run-1', 'run-2'])).toMatchObject({ files: [{ beforeText: 'initial', afterText: 'final' }] })
    expect(await service.getForRuns(['run-2'])).toMatchObject({ files: [{ beforeText: 'middle', afterText: 'final' }] })
    expect(await service.getForRuns(['run-1', 'run-2', 'run-3'])).toMatchObject({ files: [] })
    expect(await service.getForRuns([])).toMatchObject({ coverage: 'complete', files: [], status: 'completed' })
  })

  it('marks bash coverage as partial without parsing its command', async () => {
    const database = openBuddyDatabase({ databasePath: ':memory:' })
    databases.push(database)
    seedRun(database)
    const root = await mkdtemp(join(tmpdir(), 'lexora-buddy-changes-partial-'))
    directories.push(root)
    const service = new ChangeCaptureService({
      paths: new BuddyDataPaths(root),
      repository: createChangeSetRepository(database),
    })

    await service.markPartial({
      conversationId: 'conversation-1',
      runId: 'run-1',
    })
    await service.finalizeRun('run-1')

    expect(service.listSummariesForRuns(['run-1'])).toMatchObject([{
      coverage: 'partial',
      fileCount: 0,
      status: 'completed',
    }])
  })

  it('degrades a missing text snapshot instead of presenting an empty diff', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lexora-buddy-changes-missing-'))
    directories.push(root)
    const workspace = join(root, 'workspace')
    await mkdir(workspace)
    const grants = [{ canonicalRoot: workspace, grantId: 'directory-1', kind: 'workspace' as const, root: workspace }]
    const path = join(workspace, 'hello.ts')
    await writeFile(path, 'before\n')
    const database = openBuddyDatabase({ databasePath: ':memory:' })
    databases.push(database)
    seedRun(database)
    const repository = createChangeSetRepository(database)
    const service = new ChangeCaptureService({
      paths: new BuddyDataPaths(root),
      repository,
    })

    await service.beginFileTool({
      arguments: { path },
      conversationId: 'conversation-1',
      cwd: workspace,
      grants,
      runId: 'run-1',
      toolCallId: 'tool-1',
      toolName: 'edit',
    })
    await writeFile(path, 'after\n')
    await service.finishFileTool({
      conversationId: 'conversation-1',
      cwd: workspace,
      grants,
      isError: false,
      runId: 'run-1',
      toolCallId: 'tool-1',
      toolName: 'edit',
    })
    await service.finalizeRun('run-1')
    const snapshotPath = repository.listCaptures('run-1')[0]?.before.snapshotPath
    expect(snapshotPath).toBeTruthy()
    await unlink(snapshotPath!)

    await expect(service.getVisibleDetail('run-1')).resolves.toMatchObject({
      files: [{
        afterText: null,
        beforeText: null,
        preview: 'unavailable',
      }],
    })
  })
})

function seedRun(database: DatabaseSync, index = 1): void {
  prepareTestTurnRequest(database, {
    attachmentBindings: [],
    branchId: 'branch-1',
    conversationId: 'conversation-1',
    createdAt: '2026-08-28T00:00:00.000Z',
    approvalPolicy: 'policy' as const,
    executionProfile: 'workspace_write',
    model: 'model-1',
    spaceId: null,
    provider: 'provider-1',
    requestFingerprint: 'fingerprint-1',
    requestId: `request-${index}`,
    runId: `run-${index}`,
    runInput: {
      attachmentIds: [],
      contextItems: [],
      prompt: 'hello',
      reasoning: null,
      serviceTier: null,
    },
    title: 'Conversation',
    userMessageContent: { attachmentIds: [], text: 'hello' },
    userMessageId: `message-${index}`,
  })
}
