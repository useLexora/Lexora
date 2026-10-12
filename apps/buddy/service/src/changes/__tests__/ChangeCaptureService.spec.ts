import type { DatabaseSync } from 'node:sqlite'
import type { ChangeCaptureEvent, ChangeInvocationHandle, ChangeInvocationInput } from '../ChangeCaptureService'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, open, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { prepareTestTurnRequest } from '../../storage/__tests__/composerDraftTestFixture'
import { BuddyDataPaths } from '../../storage/BuddyDataPaths'
import { openBuddyDatabase } from '../../storage/database'
import { ChangeCaptureService } from '../ChangeCaptureService'
import { createChangeSetRepository } from '../changeSetRepository'
import { MutationCoordinator } from '../MutationCoordinator'

const databases: DatabaseSync[] = []
const directories: string[] = []

afterEach(async () => {
  for (const database of databases.splice(0))
    database.close()
  await Promise.all(directories.splice(0).map(path => rm(path, { force: true, recursive: true })))
})

describe('changeCaptureService', () => {
  it('retains root-child-root file ownership and permits duplicate provider tool IDs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-change-ownership-'))
    directories.push(root)
    const workspace = join(root, 'workspace')
    await mkdir(workspace)
    const path = join(workspace, 'value.txt')
    await writeFile(path, 'A')
    const database = openBuddyDatabase({ databasePath: ':memory:' })
    databases.push(database)
    seedRun(database)
    database.prepare('UPDATE runs SET status = \'completed\' WHERE id = \'run-1\'').run()
    seedRun(database, 2)
    const repository = createChangeSetRepository(database)
    const service = new ChangeCaptureService({ paths: new BuddyDataPaths(root), repository })
    const mutations = new MutationCoordinator()
    for (const [index, [runId, text]] of [['run-1', 'B'], ['run-2', 'C'], ['run-1', 'D'], ['run-1', 'E']].entries()) {
      const lease = await mutations.acquire({ lifetime: 'runtime' as const, runId: runId!, invocationId: `invocation-${index}`, claims: [{ kind: 'file', canonicalPath: path }], signal: new AbortController().signal })
      const handle = await service.beginInvocation({ conversationId: 'conversation-1', cwd: workspace, grants: [{ root: workspace, canonicalRoot: workspace, grantId: 'workspace', kind: 'workspace' }], invocationId: lease.invocationId, runId: lease.runId, segmentId: lease.segmentId, toolCallId: 'provider-reused-id', toolName: 'write', scope: { kind: 'files', paths: [path] } })
      await writeFile(path, text!)
      await service.finishInvocation(handle, { isError: false })
      lease.release()
    }
    await service.finalizeRun('run-1')
    await service.finalizeRun('run-2')
    expect((await service.getVisibleDetail('run-1')).files.map(file => [file.beforeText, file.afterText, file.source?.runId])).toEqual([['A', 'B', 'run-1'], ['C', 'E', 'run-1']])
    const files = (await service.getForRuns(['run-1', 'run-2'])).files
    expect(files.map(file => [file.beforeText, file.afterText, file.source?.runId])).toEqual([['A', 'B', 'run-1'], ['B', 'C', 'run-2'], ['C', 'E', 'run-1']])
    expect(files[2]?.source?.invocationIds).toEqual(['invocation-2', 'invocation-3'])
    expect(repository.listCaptures('run-1')).toHaveLength(3)
    expect(repository.listCaptures('run-2')).toHaveLength(1)
    mutations.dispose()
    await service.dispose()
  })

  it('keeps invocation scope after grant revocation and interrupts incomplete workspace capture on restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-change-invocation-'))
    directories.push(root)
    const workspace = join(root, 'workspace')
    await mkdir(workspace)
    const path = join(workspace, 'value.txt')
    await writeFile(path, 'before')
    const database = openBuddyDatabase({ databasePath: ':memory:' })
    databases.push(database)
    seedRun(database)
    const repository = createChangeSetRepository(database)
    const service = new ChangeCaptureService({ paths: new BuddyDataPaths(root), repository })
    const grants = [{ root: workspace, canonicalRoot: workspace, grantId: 'temporary', kind: 'granted' as const }]
    const input = { conversationId: 'conversation-1', cwd: workspace, grants, invocationId: 'first', runId: 'run-1', segmentId: 'segment', toolCallId: 'same-id', toolName: 'write', scope: { kind: 'files' as const, paths: [path] } }
    const handle = await service.beginInvocation(input)
    grants.length = 0
    await writeFile(path, 'after')
    expect(await service.finishInvocation(handle, { isError: true })).toEqual({ complete: true })
    await expect(service.finishInvocation({ ...handle, runId: 'another-run' }, { isError: false })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
    await service.beginInvocation({ ...input, invocationId: 'interrupted', grants: [{ root: workspace, canonicalRoot: workspace, grantId: 'workspace', kind: 'workspace' }], scope: { kind: 'workspace' } })
    await service.dispose()
    const recovered = new ChangeCaptureService({ paths: new BuddyDataPaths(root), repository })
    await recovered.markInterrupted('run-1')
    expect(repository.findInvocation('interrupted')?.status).toBe('partial')
    expect(await recovered.getVisibleDetail('run-1')).toMatchObject({ coverage: 'partial', status: 'completed', files: [{ beforeText: 'before', afterText: 'after' }] })
    await recovered.dispose()
  })

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
    await beginFile(service, { ...input, arguments: { path } })
    await writeFile(path, 'private after')
    await expect(finishFile(service, { ...input, isError: false })).rejects.toMatchObject({ code: 'CHANGE_COVERAGE_UNCONFIRMED' })
    expect(repository.listCaptures(input.runId)[0]?.status).toBe('completed')
    await expect(service.markPartial(input)).rejects.toMatchObject({ code: 'CHANGE_COVERAGE_UNCONFIRMED' })
    expect(repository.findSetById(input.runId)?.coverage).toBe('complete')
    expect(events.map(event => event.kind)).toEqual(expect.arrayContaining(['set-created', 'capture-committed', 'coverage-unconfirmed']))
    failing = false
    await finishFile(service, { ...input, isError: false })
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
    const before = beginWorkspace(service, input)
    input.grants.length = 0
    const finalized = service.finalizeRun(input.runId)
    const disposed = service.dispose()
    await Promise.all([before, finalized, disposed])
    expect(repository.findSetById(input.runId)).toMatchObject({ coverage: 'partial', status: 'completed' })
    expect(events.map(event => event.kind)).toEqual(['set-created', 'coverage-changed', 'finalized'])
    expect(events.map(event => event.revision)).toEqual([1, 2, 3])
    await expect(beginWorkspace(service, input)).rejects.toThrow('CHANGE_CAPTURE_STOPPED')
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
    await beginWorkspace(service, input)
    await writeFile(join(workspace, 'changed.txt'), 'after')
    await finishWorkspace(service, { ...input, grants: [], isError: true, toolName: 'bash' })
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
    await beginWorkspace(service, input)
    const file = await open(path, 'r+')
    try {
      await file.truncate(33 * 1024 * 1024)
    }
    finally {
      await file.close()
    }
    expect(await finishWorkspace(service, { ...input, isError: false, toolName: 'bash' })).toEqual({ complete: false })
    await service.markPartial(input)
    await service.finalizeRun(input.runId)
    expect(await service.getVisibleDetail(input.runId)).toMatchObject({ coverage: 'partial', files: [], fileCount: 0 })
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

    await beginWorkspace(service, {
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

    await expect(finishWorkspace(service, {
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

    await beginFile(service, {
      arguments: { path },
      conversationId: 'conversation-1',
      cwd: workspace,
      grants,
      runId: 'run-1',
      toolCallId: 'tool-1',
      toolName: 'write',
    })
    await writeFile(path, 'export const greeting = "middle"\n')
    await finishFile(service, {
      conversationId: 'conversation-1',
      cwd: workspace,
      grants,
      isError: false,
      runId: 'run-1',
      toolCallId: 'tool-1',
      toolName: 'write',
    })
    await beginFile(service, {
      arguments: { path },
      conversationId: 'conversation-1',
      cwd: workspace,
      grants,
      runId: 'run-1',
      toolCallId: 'tool-2',
      toolName: 'edit',
    })
    await writeFile(path, 'export const greeting = "after"\n')
    await finishFile(service, {
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

  it('preserves delivered legacy net diffs and isolates the requested history', async () => {
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
      await beginFile(service, { ...input, arguments: { path } })
      await writeFile(path, text)
      await finishFile(service, { ...input, isError: false })
      await service.finalizeRun(input.runId)
      database.prepare('UPDATE run_file_change_captures SET invocation_id = NULL WHERE change_set_id = ?').run(input.runId)
      database.prepare('UPDATE runs SET status = \'completed\' WHERE id = ?').run(input.runId)
    }
    expect(await service.getForRuns(['run-1', 'run-2'])).toMatchObject({ files: [{ beforeText: 'initial', afterText: 'final' }] })
    expect(await service.getForRuns(['run-2'])).toMatchObject({ files: [{ beforeText: 'middle', afterText: 'final' }] })
    expect(await service.getForRuns(['run-1', 'run-2', 'run-3'])).toMatchObject({ files: [] })
    expect(await service.getForRuns([])).toMatchObject({ coverage: 'complete', files: [], status: 'completed' })
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

    await beginFile(service, {
      arguments: { path },
      conversationId: 'conversation-1',
      cwd: workspace,
      grants,
      runId: 'run-1',
      toolCallId: 'tool-1',
      toolName: 'edit',
    })
    await writeFile(path, 'after\n')
    await finishFile(service, {
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

type CaptureInput = Omit<ChangeInvocationInput, 'invocationId' | 'segmentId' | 'scope' | 'toolName'> & { toolName?: string }
const handles = new WeakMap<ChangeCaptureService, Map<string, ChangeInvocationHandle>>()
async function beginFile(service: ChangeCaptureService, input: CaptureInput & { arguments: { path: string } }) {
  return beginCapture(service, input, { kind: 'files', paths: [input.arguments.path] })
}
async function beginWorkspace(service: ChangeCaptureService, input: CaptureInput) {
  return beginCapture(service, input, { kind: 'workspace' })
}
async function beginCapture(service: ChangeCaptureService, input: CaptureInput, scope: ChangeInvocationInput['scope']) {
  const handle = await service.beginInvocation({ conversationId: input.conversationId, cwd: input.cwd, grants: input.grants, runId: input.runId, toolCallId: input.toolCallId, toolName: input.toolName ?? 'bash', scope, invocationId: randomUUID(), segmentId: `${input.runId}-segment` })
  const calls = handles.get(service) ?? new Map<string, ChangeInvocationHandle>()
  calls.set(`${input.runId}:${input.toolCallId}`, handle)
  handles.set(service, calls)
}
async function finishWorkspace(service: ChangeCaptureService, input: CaptureInput & { isError: boolean }) {
  const handle = handles.get(service)!.get(`${input.runId}:${input.toolCallId}`)!
  return service.finishInvocation(handle, { isError: input.isError })
}
async function finishFile(service: ChangeCaptureService, input: CaptureInput & { isError: boolean }) {
  await finishWorkspace(service, input)
}
