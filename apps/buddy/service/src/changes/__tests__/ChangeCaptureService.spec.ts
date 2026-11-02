import type { DatabaseSync } from 'node:sqlite'
import type { ChangeCaptureEvent } from '../ChangeCaptureService'
import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises'
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
      const handle = await service.beginInvocation({ conversationId: 'conversation-1', cwd: workspace, grants: [{ root: workspace, canonicalRoot: workspace, grantId: 'workspace', kind: 'workspace' }], invocationId: lease.invocationId, runId: lease.runId, segmentId: lease.segmentId, toolCallId: 'provider-reused-id', toolName: index === 3 ? 'edit' : 'write', scope: { kind: 'files', paths: [path] } })
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
    expect(service.listSummariesForRuns(['run-1'])).toEqual([{
      changeSetId: 'run-1',
      conversationId: 'conversation-1',
      coverage: 'complete',
      coverageReasons: [],
      fileCount: 2,
      runId: 'run-1',
      status: 'completed',
      updatedAt: expect.any(String),
    }])
    expect(files[0]).toMatchObject({ changeType: 'modified', path: 'value.txt', preview: 'text' })
    mutations.dispose()
    await service.dispose()
  })

  it('marks a file capture partial when an unknown writer starts after finishing was requested', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-change-concurrent-'))
    directories.push(root)
    const path = join(root, 'shared.txt')
    await writeFile(path, 'before')
    const database = openBuddyDatabase({ databasePath: ':memory:' })
    databases.push(database)
    seedRun(database)
    const repository = createChangeSetRepository(database)
    const service = new ChangeCaptureService({ paths: new BuddyDataPaths(root), repository })
    const mutations = new MutationCoordinator()
    const signal = new AbortController().signal
    const file = await mutations.acquire({ runId: 'run-1', invocationId: 'file', claims: [{ kind: 'file', canonicalPath: path }], lifetime: 'runtime', signal })
    try {
      const handle = await service.beginInvocation({ conversationId: 'conversation-1', cwd: root, grants: [{ root, canonicalRoot: root, grantId: 'workspace', kind: 'workspace' }], invocationId: file.invocationId, runId: file.runId, segmentId: file.segmentId, toolCallId: 'write', toolName: 'write', scope: { kind: 'files', paths: [path] } })
      await writeFile(path, 'after')
      expect(file.hasConcurrentChanges()).toBe(false)
      const finished = service.finishInvocation(handle, { isError: false, hasConcurrentChanges: file.hasConcurrentChanges })
      const shell = await mutations.acquire({ runId: 'run-2', invocationId: 'shell', claims: [{ kind: 'tree', canonicalPath: root }], lifetime: 'external', coordination: 'observe', captureBoundary: true, signal })
      shell.release()
      expect(await finished).toEqual({ complete: false })
      expect(repository.findInvocation('file')?.status).toBe('partial')
      expect(await service.getForRuns(['run-1'])).toMatchObject({ coverage: 'partial', coverageReasons: ['untracked'], files: [{ beforeText: 'before', afterText: 'after' }] })
    }
    finally {
      file.release()
      await mutations.dispose()
      await service.dispose()
    }
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
    await service.beginInvocation({ ...input, invocationId: 'interrupted', grants: [{ root: workspace, canonicalRoot: workspace, grantId: 'workspace', kind: 'workspace' }], scope: { kind: 'untracked' } })
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
    const handle = await service.beginInvocation({ ...input, invocationId: 'capture', segmentId: 'segment', scope: { kind: 'files', paths: [path] } })
    await writeFile(path, 'private after')
    await expect(service.finishInvocation(handle, { isError: false })).rejects.toMatchObject({ code: 'CHANGE_COVERAGE_UNCONFIRMED' })
    expect(repository.listCaptures(input.runId)[0]?.status).toBe('completed')
    await expect(service.markPartial(input)).rejects.toMatchObject({ code: 'CHANGE_COVERAGE_UNCONFIRMED' })
    expect(repository.findSetById(input.runId)?.coverage).toBe('complete')
    expect(events.map(event => event.kind)).toEqual(expect.arrayContaining(['set-created', 'capture-committed', 'coverage-unconfirmed']))
    failing = false
    await service.finishInvocation(handle, { isError: false })
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

  it('drains an accepted untracked invocation before finalization and rejects work after shutdown', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-change-drain-'))
    directories.push(root)
    const database = openBuddyDatabase({ databasePath: ':memory:' })
    databases.push(database)
    seedRun(database)
    const repository = createChangeSetRepository(database)
    const service = new ChangeCaptureService({ paths: new BuddyDataPaths(root), repository })
    const events: ChangeCaptureEvent[] = []
    service.onDidChange(event => events.push(event))
    const input = { conversationId: 'conversation-1', runId: 'run-1', invocationId: 'untracked', segmentId: 'segment', toolCallId: 'shell-1', toolName: 'bash', cwd: root, grants: [], scope: { kind: 'untracked' as const } }
    const before = service.beginInvocation(input)
    const finalized = service.finalizeRun(input.runId)
    const disposed = service.dispose()
    await Promise.all([before, finalized, disposed])
    expect(repository.findSetById(input.runId)).toMatchObject({ coverage: 'partial', status: 'completed' })
    expect(events.map(event => event.kind)).toEqual(['set-created', 'coverage-changed', 'finalized'])
    expect(events.map(event => event.revision)).toEqual([1, 2, 3])
    await expect(service.beginInvocation(input)).rejects.toThrow('CHANGE_CAPTURE_STOPPED')
  })

  it('records untracked effects only for executed invocations without attributing workspace files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-untracked-change-'))
    directories.push(root)
    const database = openBuddyDatabase({ databasePath: ':memory:' })
    databases.push(database)
    seedRun(database)
    const repository = createChangeSetRepository(database)
    const service = new ChangeCaptureService({ paths: new BuddyDataPaths(root), repository })
    const input = { cwd: root, conversationId: 'conversation-1', runId: 'run-1', toolCallId: 'shell', toolName: 'bash', grants: [{ root, canonicalRoot: root, grantId: 'workspace', kind: 'workspace' as const }], segmentId: 'segment', scope: { kind: 'untracked' as const } }
    const cancelled = await service.beginInvocation({ ...input, invocationId: 'cancelled' })
    await service.finishInvocation(cancelled, { isError: true, started: false })
    await service.finalizeRun('run-1')
    expect(repository.findSetById('run-1')).toMatchObject({ coverage: 'complete', coverageReasons: [], fileCount: 0 })
    database.prepare('UPDATE runs SET status = \'completed\' WHERE id = \'run-1\'').run()
    seedRun(database, 2)
    const executed = await service.beginInvocation({ ...input, runId: 'run-2', invocationId: 'executed' })
    await writeFile(join(root, 'external.txt'), 'unattributed')
    expect(await service.finishInvocation(executed, { isError: false })).toEqual({ complete: false })
    await service.finalizeRun('run-2')
    expect(await service.getVisibleDetail('run-2')).toMatchObject({ coverage: 'partial', coverageReasons: ['untracked'], files: [], fileCount: 0 })
    await service.dispose()
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
      const handle = await service.beginInvocation({ ...input, invocationId: input.toolCallId, segmentId: input.runId, scope: { kind: 'files', paths: [path] } })
      await writeFile(path, text)
      await service.finishInvocation(handle, { isError: false })
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

    const handle = await service.beginInvocation({
      conversationId: 'conversation-1',
      cwd: workspace,
      grants,
      runId: 'run-1',
      invocationId: 'capture',
      segmentId: 'segment',
      scope: { kind: 'files', paths: [path] },
      toolCallId: 'tool-1',
      toolName: 'edit',
    })
    await writeFile(path, 'after\n')
    await service.finishInvocation(handle, { isError: false })
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
