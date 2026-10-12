import type { DirectoryGrant } from '../directories/resolveGrantedPath'
import type { BuddyDataPaths } from '../storage/BuddyDataPaths'
import type {
  CapturedFileStateRecord,
  ChangeSetRecord,
  ChangeSetRepository,
  FileChangeCaptureRecord,
} from './changeSetRepository'
import type { WorkspaceSnapshot, WorkspaceSnapshotState } from './workspaceSnapshot'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { Emitter } from '../../../shared/events/Emitter'
import { copyEventSnapshot } from '../../../shared/events/eventSnapshot'
import { resolveGrantedPath } from '../directories/resolveGrantedPath'
import { captureChangeFile } from './captureChangeFile'
import { displayGrantedPath } from './changeFileContent'
import { captureWorkspaceSnapshot } from './workspaceSnapshot'

interface FileToolInput {
  conversationId: string
  cwd: string
  grants: readonly DirectoryGrant[]
  runId: string
  toolCallId: string
  toolName: string
  invocationId: string
  captureId?: string
}

export interface ChangeInvocationInput {
  conversationId: string
  cwd: string
  grants: readonly DirectoryGrant[]
  invocationId: string
  runId: string
  segmentId: string
  toolCallId: string
  toolName: string
  scope: { kind: 'files', paths: readonly string[] } | { kind: 'workspace' }
  coverage?: 'complete' | 'partial'
}

export interface ChangeInvocationHandle {
  readonly invocationId: string
  readonly runId: string
}

interface PendingInvocation {
  input: ChangeInvocationInput
  captures: string[]
}

export interface LocalChangeSetSummary {
  changeSetId: string
  conversationId: string
  coverage: 'complete' | 'partial'
  fileCount: number
  runId: string
  status: 'capturing' | 'completed'
  updatedAt: string
}

export interface LocalFileChangeDetail {
  afterSizeBytes: number | null
  afterText: string | null
  beforeSizeBytes: number | null
  beforeText: string | null
  changeType: 'created' | 'deleted' | 'modified'
  id: string
  language: string | null
  path: string
  preview: 'binary' | 'oversized' | 'sensitive' | 'text' | 'unavailable'
  redacted: boolean
  source?: {
    actorId: string | null
    actorName: string | null
    runId: string
    segmentId: string
    sequence: number
    invocationIds: string[]
  } | null
}

export interface LocalChangeSetDetail extends LocalChangeSetSummary {
  files: LocalFileChangeDetail[]
}

interface PendingWorkspaceCapture {
  conversationId: string
  grants: readonly DirectoryGrant[]
  runId: string
  snapshot: WorkspaceSnapshot
}

export interface ChangeCaptureEvent {
  readonly sourceId: string
  readonly revision: number
  readonly operationId: string
  readonly conversationId?: string
  readonly runId: string
  readonly kind: 'set-created' | 'capture-committed' | 'coverage-changed' | 'count-changed' | 'finalized' | 'operation-failed' | 'coverage-unconfirmed'
  readonly captureId?: string
  readonly toolCallId?: string
  readonly phase?: 'before' | 'after' | 'workspace'
  readonly coverage?: 'complete' | 'partial'
  readonly count?: number
  readonly errorCode?: 'CHANGE_CAPTURE_FAILED' | 'CHANGE_COVERAGE_UNCONFIRMED'
}

interface WorkspaceToolInput {
  conversationId: string
  cwd: string
  grants: readonly DirectoryGrant[]
  runId: string
  toolCallId: string
  invocationId: string
}

export class ChangeCaptureService {
  readonly #paths: BuddyDataPaths
  readonly #repository: ChangeSetRepository
  readonly #changes: Emitter<ChangeCaptureEvent>
  readonly onDidChange
  readonly #mutations = new Map<string, Promise<unknown>>()
  readonly #contexts = new Map<string, { operationId: string, conversationId?: string }>()
  readonly #sourceId = randomUUID()
  #revision = 0
  #disposed = false
  readonly #workspaceCaptures = new Map<string, PendingWorkspaceCapture>()
  readonly #invocations = new Map<string, PendingInvocation>()

  constructor(options: { paths: BuddyDataPaths, repository: ChangeSetRepository, onListenerError?: (error: unknown) => void }) {
    this.#paths = options.paths
    this.#repository = options.repository
    this.#changes = new Emitter(options.onListenerError ?? (() => console.error('CHANGE_CAPTURE_OBSERVER_FAILED')))
    this.onDidChange = this.#changes.event
  }

  beginInvocation(input: ChangeInvocationInput): Promise<ChangeInvocationHandle> {
    const request = copyEventSnapshot(input)
    return this.#operate(request.runId, 'before', async () => {
      const now = new Date().toISOString()
      this.#ensureSet(request.runId, request.conversationId, now)
      this.#repository.createInvocation({ id: request.invocationId, runId: request.runId, segmentId: request.segmentId, toolCallId: request.toolCallId, toolName: request.toolName, status: 'pending', createdAt: now, completedAt: null })
      const pending: PendingInvocation = { input: request, captures: [] }
      this.#invocations.set(request.invocationId, pending)
      try {
        if (request.scope.kind === 'workspace') {
          await this.#beginWorkspaceTool(request)
        }
        else {
          for (const path of request.scope.paths)
            pending.captures.push(await this.#beginFileTool({ ...request, arguments: { path } }))
        }
        if (request.coverage === 'partial')
          await this.#markPartial(request)
      }
      catch (error) {
        this.#repository.completeInvocation(request.invocationId, 'partial', new Date().toISOString())
        await this.#markPartial(request)
        throw error
      }
      return Object.freeze({ invocationId: request.invocationId, runId: request.runId })
    }, request.conversationId)
  }

  finishInvocation(handle: ChangeInvocationHandle, outcome: { isError: boolean, settlement?: 'released' | 'unknown' }): Promise<{ complete: boolean }> {
    return this.#operate(handle.runId, 'after', async () => {
      const record = this.#repository.findInvocation(handle.invocationId)
      if (!record || record.runId !== handle.runId)
        throw new ChangeCaptureError('VALIDATION_FAILED')
      const pending = this.#invocations.get(handle.invocationId)
      if (!pending)
        return { complete: record.status === 'completed' }
      const { input } = pending
      let complete = input.coverage !== 'partial' && outcome.settlement !== 'unknown'
      try {
        if (input.scope.kind === 'workspace') {
          const result = await this.#finishWorkspaceTool({ ...input, isError: outcome.isError })
          complete &&= result.complete
        }
        else {
          for (const captureId of pending.captures)
            await this.#finishFileTool({ ...input, captureId, isError: outcome.isError })
        }
        if (!complete)
          await this.#markPartial(input)
        this.#repository.completeInvocation(handle.invocationId, complete ? 'completed' : 'partial', new Date().toISOString())
        this.#refreshFileCount(handle.runId, new Date().toISOString())
        return { complete }
      }
      catch (error) {
        this.#repository.completeInvocation(handle.invocationId, 'partial', new Date().toISOString())
        await this.#markPartial(input)
        throw error
      }
      finally {
        this.#invocations.delete(handle.invocationId)
      }
    })
  }

  markPartial(input: { conversationId: string, runId: string }): Promise<void> {
    const request = copyEventSnapshot(input)
    return this.#operate(request.runId, 'coverage', () => this.#markPartial(request), request.conversationId)
  }

  markInterrupted(runId: string): Promise<void> {
    return this.#operate(runId, 'finalize', () => this.#markInterrupted(runId))
  }

  finalizeRun(runId: string): Promise<void> {
    return this.#operate(runId, 'finalize', () => this.#finalizeRun(runId))
  }

  async dispose(): Promise<void> {
    this.#disposed = true
    await Promise.allSettled([...this.#mutations.values()])
    this.#workspaceCaptures.clear()
    this.#invocations.clear()
    this.#changes.dispose()
  }

  #operate<T>(runId: string, phase: 'before' | 'after' | 'coverage' | 'finalize', operation: () => Promise<T>, conversationId?: string): Promise<T> {
    if (this.#disposed)
      return Promise.reject(new Error('CHANGE_CAPTURE_STOPPED'))
    const previous = this.#mutations.get(runId) ?? Promise.resolve()
    const pending = previous.catch(() => {}).then(async () => {
      this.#contexts.set(runId, { operationId: randomUUID(), conversationId })
      try {
        const current = this.#repository.findSetById(runId)
        if (current)
          this.#contexts.get(runId)!.conversationId = current.conversationId
        if ((phase === 'before' || phase === 'after') && current?.status === 'completed')
          throw new ChangeCaptureError('CHANGE_SET_FINALIZED')
        return await operation()
      }
      catch (error) {
        const unconfirmed = phase === 'coverage' || (error instanceof ChangeCaptureError && error.code === 'CHANGE_COVERAGE_UNCONFIRMED')
        this.#publish(runId, { kind: unconfirmed ? 'coverage-unconfirmed' : 'operation-failed', errorCode: unconfirmed ? 'CHANGE_COVERAGE_UNCONFIRMED' : 'CHANGE_CAPTURE_FAILED' })
        throw error
      }
      finally {
        this.#contexts.delete(runId)
      }
    }).finally(() => {
      if (this.#mutations.get(runId) === pending)
        this.#mutations.delete(runId)
    })
    this.#mutations.set(runId, pending)
    return pending
  }

  #publish(runId: string, details: Omit<ChangeCaptureEvent, 'sourceId' | 'revision' | 'operationId' | 'conversationId' | 'runId'>): void {
    const context = this.#contexts.get(runId)!
    this.#changes.fire(copyEventSnapshot({ ...details, ...context, runId, sourceId: this.#sourceId, revision: ++this.#revision }))
  }

  async #beginFileTool(input: FileToolInput & { arguments: unknown }): Promise<string> {
    const requestedPath = readToolPath(input.arguments)
    const absolutePath = isAbsolute(requestedPath)
      ? requestedPath
      : resolve(input.cwd, requestedPath)
    const resolution = await resolveGrantedPath(
      input.grants,
      absolutePath,
      input.toolName === 'edit' ? 'existing' : 'create',
    )
    const grant = requireGrant(input.grants, resolution.grantId)
    const captureId = randomUUID()
    const relativePath = displayGrantedPath(input.cwd, grant, resolution.canonicalPath)
    const before = await this.#captureState({
      absolutePath: resolution.canonicalPath,
      captureId,
      conversationId: input.conversationId,
      relativePath,
      runId: input.runId,
      side: 'before',
    })
    const now = new Date().toISOString()
    this.#ensureSet(input.runId, input.conversationId, now)
    this.#repository.createCapture({
      after: null,
      before,
      canonicalPath: resolution.canonicalPath,
      changeSetId: input.runId,
      completedAt: null,
      createdAt: now,
      directoryGrantId: resolution.grantId,
      id: captureId,
      invocationId: input.invocationId,
      relativePath,
      status: 'pending',
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      toolReportedError: null,
    })
    this.#publish(input.runId, { kind: 'capture-committed', phase: 'before', captureId, toolCallId: input.toolCallId })
    return captureId
  }

  async #finishFileTool(
    input: FileToolInput & { isError: boolean, captureId: string },
  ): Promise<void> {
    const capture = this.#repository.findCaptureById(input.captureId)
    if (!capture || capture.changeSetId !== input.runId || capture.status !== 'pending')
      return
    if (!capture.canonicalPath || !capture.directoryGrantId)
      throw new ChangeCaptureError('VALIDATION_FAILED')
    const resolution = await resolveGrantedPath(input.grants, capture.canonicalPath, 'create')
    if (resolution.grantId !== capture.directoryGrantId)
      throw new ChangeCaptureError('PATH_OUTSIDE_GRANTED_DIRECTORY')
    const after = await this.#captureState({
      absolutePath: resolution.canonicalPath,
      captureId: capture.id,
      conversationId: input.conversationId,
      relativePath: capture.relativePath,
      runId: input.runId,
      side: 'after',
    })
    const now = new Date().toISOString()
    if (this.#repository.completeCapture(capture.id, after, input.isError, now))
      this.#publish(input.runId, { kind: 'capture-committed', phase: 'after', captureId: capture.id, toolCallId: input.toolCallId })
    this.#refreshFileCount(input.runId, now)
  }

  async #beginWorkspaceTool(input: WorkspaceToolInput): Promise<void> {
    const grants = input.grants.map(grant => ({ ...grant }))
    const snapshot = await captureWorkspaceSnapshot(grants, input.cwd)
    this.#ensureSet(input.runId, input.conversationId, new Date().toISOString())
    this.#workspaceCaptures.set(input.invocationId, {
      conversationId: input.conversationId,
      grants,
      runId: input.runId,
      snapshot,
    })
  }

  async #finishWorkspaceTool(input: WorkspaceToolInput & {
    isError: boolean
    toolName: string
  }): Promise<{ complete: boolean }> {
    const key = input.invocationId
    const before = this.#workspaceCaptures.get(key)
    if (
      !before
      || before.conversationId !== input.conversationId
      || before.runId !== input.runId
    ) {
      throw new ChangeCaptureError('VALIDATION_FAILED')
    }
    this.#workspaceCaptures.delete(key)
    const after = await captureWorkspaceSnapshot(before.grants, input.cwd)
    await this.#persistWorkspaceChanges({
      after: after.files,
      afterComplete: after.complete,
      before: before.snapshot.files,
      beforeComplete: before.snapshot.complete,
      conversationId: input.conversationId,
      isError: input.isError,
      runId: input.runId,
      invocationId: input.invocationId,
      toolCallId: input.toolCallId,
      toolName: input.toolName,
    })
    return { complete: before.snapshot.complete && after.complete }
  }

  async #markPartial(input: { conversationId: string, runId: string }): Promise<void> {
    const now = new Date().toISOString()
    this.#ensureSet(input.runId, input.conversationId, now)
    if (this.#setPartial(input.runId, now))
      this.#publish(input.runId, { kind: 'coverage-changed', coverage: 'partial' })
  }

  async #markInterrupted(runId: string): Promise<void> {
    this.#repository.interruptInvocations(runId, new Date().toISOString())
    this.#discardWorkspaceCaptures(runId)
    const changeSet = this.#repository.findSetById(runId)
    if (!changeSet)
      return
    const now = new Date().toISOString()
    if (this.#setPartial(runId, now))
      this.#publish(runId, { kind: 'coverage-changed', coverage: 'partial' })
    const captures = this.#repository.listCaptures(runId)
    const count = aggregateCaptures(captures).length
    if (this.#repository.finalizeSet(runId, count, now))
      this.#publish(runId, { kind: 'finalized', count })
  }

  async #finalizeRun(runId: string): Promise<void> {
    const interrupted = this.#repository.interruptInvocations(runId, new Date().toISOString())
    const pendingWorkspace = [...this.#workspaceCaptures.values()].some(capture => capture.runId === runId)
    this.#discardWorkspaceCaptures(runId)
    const changeSet = this.#repository.findSetById(runId)
    if (!changeSet)
      return
    const captures = this.#repository.listCaptures(runId)
    if ((interrupted > 0 || pendingWorkspace || captures.some(capture => capture.status === 'pending')) && this.#setPartial(runId, new Date().toISOString()))
      this.#publish(runId, { kind: 'coverage-changed', coverage: 'partial' })
    const now = new Date().toISOString()
    const count = aggregateCaptures(captures).length
    if (this.#repository.finalizeSet(runId, count, now))
      this.#publish(runId, { kind: 'finalized', count })
  }

  listSummariesForRuns(runIds: readonly string[]): LocalChangeSetSummary[] {
    const sets = this.#repository.listSetsForRunTrees(runIds)
    return runIds.flatMap((runId) => {
      const members = sets.filter(set => set.runId === runId || set.rootRunId === runId)
      const visible = members.filter(set => set.fileCount > 0 || set.coverage === 'partial')
      const run = this.#repository.findVisibleRun(runId)
      if (!visible.length || !run)
        return []
      return [{
        changeSetId: runId,
        conversationId: run.conversationId,
        runId,
        coverage: members.some(set => set.coverage === 'partial') ? 'partial' : 'complete',
        status: members.some(set => set.status === 'capturing') || (!members.some(set => set.runId === runId) && !['completed', 'failed', 'cancelled'].includes(run.status)) ? 'capturing' : 'completed',
        updatedAt: members.map(set => set.updatedAt).sort().at(-1)!,
        fileCount: members.reduce((count, set) => count + set.fileCount, 0),
      }]
    })
  }

  async getVisibleDetail(changeSetId: string): Promise<LocalChangeSetDetail> {
    const sets = this.#repository.listSetsForRunTrees([changeSetId])
    const run = this.#repository.findVisibleRun(changeSetId)
    if (!run || !sets.length)
      throw new ChangeCaptureError('CHANGE_SET_NOT_FOUND')
    const summary = this.listSummariesForRuns([changeSetId])[0] ?? { ...toSummary(sets[0]!), changeSetId, runId: changeSetId, conversationId: run.conversationId }
    const detail = await this.getForRuns(sets.map(set => set.runId))
    if (!this.#repository.findVisibleRun(changeSetId))
      throw new ChangeCaptureError('CHANGE_SET_NOT_FOUND')
    return { ...summary, files: detail.files }
  }

  async getForRuns(runIds: readonly string[]) {
    const sets = this.#repository.listSetsForRuns(runIds)
    const setsByRun = new Map(sets.map(set => [set.runId, set]))
    const captures = runIds.flatMap((runId) => {
      const set = setsByRun.get(runId)
      return set ? this.#repository.listCaptures(set.id) : []
    }).sort((left, right) => (left.invocation?.sequence ?? 0) - (right.invocation?.sequence ?? 0))
    const files = await Promise.all(aggregateCaptures(captures).map(change => this.#toFileDetail(change)))
    return {
      coverage: sets.some(set => set.coverage === 'partial') ? 'partial' as const : 'complete' as const,
      status: sets.some(set => set.status === 'capturing') ? 'capturing' as const : 'completed' as const,
      updatedAt: sets.map(set => set.updatedAt).sort().at(-1) ?? null,
      files,
    }
  }

  #ensureSet(runId: string, conversationId: string, now: string): ChangeSetRecord {
    const result = this.#repository.ensureSet({
      conversationId,
      coverage: 'complete',
      createdAt: now,
      fileCount: 0,
      id: runId,
      runId,
      status: 'capturing',
      updatedAt: now,
    })
    if (result.created)
      this.#publish(runId, { kind: 'set-created', coverage: result.record.coverage, count: result.record.fileCount })
    return result.record
  }

  #setPartial(runId: string, now: string): boolean {
    try {
      return this.#repository.markPartial(runId, now)
    }
    catch {
      throw new ChangeCaptureError('CHANGE_COVERAGE_UNCONFIRMED')
    }
  }

  #refreshFileCount(changeSetId: string, now: string): void {
    const count = aggregateCaptures(this.#repository.listCaptures(changeSetId)).length
    if (this.#repository.updateFileCount(changeSetId, count, now))
      this.#publish(changeSetId, { kind: 'count-changed', count })
  }

  async #persistWorkspaceChanges(input: {
    after: ReadonlyMap<string, WorkspaceSnapshotState>
    afterComplete: boolean
    before: ReadonlyMap<string, WorkspaceSnapshotState>
    beforeComplete: boolean
    conversationId: string
    isError: boolean
    runId: string
    invocationId?: string
    toolCallId: string
    toolName: string
  }): Promise<void> {
    const changedKeys = [...new Set([...input.before.keys(), ...input.after.keys()])]
      .filter(key => (input.beforeComplete || input.before.has(key)) && (input.afterComplete || input.after.has(key)))
      .filter(key => !sameWorkspaceState(input.before.get(key), input.after.get(key)))
      .sort()
    if (changedKeys.length === 0)
      return
    const now = new Date().toISOString()
    this.#ensureSet(input.runId, input.conversationId, now)
    for (const key of changedKeys) {
      const before = input.before.get(key)
      const after = input.after.get(key)
      const state = after ?? before
      if (!state)
        continue
      const captureId = randomUUID()
      this.#repository.createCapture({
        after: await this.#materializeWorkspaceState({
          captureId,
          conversationId: input.conversationId,
          runId: input.runId,
          side: 'after',
          state: after,
        }),
        before: await this.#materializeWorkspaceState({
          captureId,
          conversationId: input.conversationId,
          runId: input.runId,
          side: 'before',
          state: before,
        }),
        canonicalPath: state.canonicalPath,
        changeSetId: input.runId,
        completedAt: now,
        createdAt: now,
        directoryGrantId: state.directoryGrantId,
        id: captureId,
        invocationId: input.invocationId,
        relativePath: state.relativePath,
        status: 'completed',
        toolCallId: input.toolCallId,
        toolName: input.toolName,
        toolReportedError: input.isError,
      })
      this.#publish(input.runId, { kind: 'capture-committed', phase: 'workspace', captureId, toolCallId: input.toolCallId })
    }
    this.#refreshFileCount(input.runId, now)
  }

  async #materializeWorkspaceState(input: {
    captureId: string
    conversationId: string
    runId: string
    side: 'after' | 'before'
    state: WorkspaceSnapshotState | undefined
  }): Promise<CapturedFileStateRecord> {
    if (!input.state)
      return emptyState('missing')
    if (input.state.kind !== 'text' || input.state.snapshotText === null) {
      return {
        hash: input.state.hash,
        kind: input.state.kind,
        redacted: input.state.redacted,
        sizeBytes: input.state.sizeBytes,
        snapshotPath: null,
      }
    }
    const snapshotPath = this.#paths.changeSnapshot(
      input.conversationId,
      input.runId,
      input.captureId,
      input.side,
    )
    await mkdir(this.#paths.conversationChangesDirectory(input.conversationId, input.runId), {
      mode: 0o700,
      recursive: true,
    })
    await writeFile(snapshotPath, input.state.snapshotText, { flag: 'wx', mode: 0o600 })
    return {
      hash: input.state.hash,
      kind: input.state.kind,
      redacted: input.state.redacted,
      sizeBytes: input.state.sizeBytes,
      snapshotPath,
    }
  }

  async #captureState(input: {
    absolutePath: string
    captureId: string
    conversationId: string
    relativePath: string
    runId: string
    side: 'after' | 'before'
  }): Promise<CapturedFileStateRecord> {
    let state
    try {
      state = await captureChangeFile(input.absolutePath, input.relativePath)
    }
    catch (error) {
      return emptyState((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unavailable')
    }
    const { snapshotText, ...capture } = state
    if (snapshotText === null)
      return { ...capture, snapshotPath: null }
    const snapshotPath = this.#paths.changeSnapshot(
      input.conversationId,
      input.runId,
      input.captureId,
      input.side,
    )
    await mkdir(this.#paths.conversationChangesDirectory(input.conversationId, input.runId), {
      mode: 0o700,
      recursive: true,
    })
    await writeFile(snapshotPath, snapshotText, { flag: 'wx', mode: 0o600 })
    return { ...capture, snapshotPath }
  }

  async #toFileDetail(change: AggregatedChange): Promise<LocalFileChangeDetail> {
    let preview = resolvePreview(change.before, change.after)
    let beforeText: string | null = null
    let afterText: string | null = null
    if (preview === 'text') {
      [beforeText, afterText] = await Promise.all([
        readSnapshot(change.before),
        readSnapshot(change.after),
      ])
      if (beforeText === null || afterText === null) {
        preview = 'unavailable'
        beforeText = null
        afterText = null
      }
    }
    return {
      afterSizeBytes: change.after.sizeBytes,
      afterText,
      beforeSizeBytes: change.before.sizeBytes,
      beforeText,
      changeType: change.before.kind === 'missing'
        ? 'created'
        : change.after.kind === 'missing'
          ? 'deleted'
          : 'modified',
      id: change.first.id,
      language: languageFromPath(change.relativePath),
      path: change.relativePath,
      preview,
      redacted: change.before.redacted || change.after.redacted,
      source: change.first.invocation
        ? { actorId: change.first.actorId ?? null, actorName: change.first.actorName ?? null, runId: change.first.invocation.runId, segmentId: change.first.invocation.segmentId, sequence: change.first.invocation.sequence, invocationIds: change.invocationIds }
        : null,
    }
  }

  #discardWorkspaceCaptures(runId: string): void {
    for (const [toolCallId, capture] of this.#workspaceCaptures) {
      if (capture.runId === runId)
        this.#workspaceCaptures.delete(toolCallId)
    }
    for (const [id, capture] of this.#invocations) {
      if (capture.input.runId === runId)
        this.#invocations.delete(id)
    }
  }
}

interface AggregatedChange {
  after: CapturedFileStateRecord
  before: CapturedFileStateRecord
  first: FileChangeCaptureRecord
  relativePath: string
  invocationIds: string[]
}

function aggregateCaptures(captures: readonly FileChangeCaptureRecord[]): AggregatedChange[] {
  const groups = new Map<string, FileChangeCaptureRecord[]>()
  for (const capture of captures) {
    const source = capture.invocation
    const owner = source ? `${source.runId}\0${source.segmentId}` : 'legacy'
    const key = `${owner}\0${capture.directoryGrantId ?? ''}\0${capture.canonicalPath ?? capture.relativePath}`
    const group = groups.get(key) ?? []
    group.push(capture)
    groups.set(key, group)
  }
  return [...groups.values()].flatMap((group) => {
    const segments: FileChangeCaptureRecord[][] = []
    for (const capture of group) {
      const segment = segments.at(-1)
      const previous = segment?.at(-1)
      if (previous && (!capture.invocation || (previous.invocation?.status === 'completed' && capture.invocation.status === 'completed' && previous.after && sameState(previous.after, capture.before))))
        segment!.push(capture)
      else
        segments.push([capture])
    }
    return segments.flatMap((segment) => {
      const first = segment[0]!
      const after = segment.at(-1)!.after ?? emptyState('unavailable')
      return sameState(first.before, after)
        ? []
        : [{ after, before: first.before, first, relativePath: first.relativePath, invocationIds: [...new Set(segment.flatMap(capture => capture.invocationId ? [capture.invocationId] : []))] }]
    })
  }).sort((left, right) => (left.first.invocation?.sequence ?? 0) - (right.first.invocation?.sequence ?? 0))
}

function sameState(left: CapturedFileStateRecord, right: CapturedFileStateRecord): boolean {
  if (left.kind !== right.kind || left.sizeBytes !== right.sizeBytes)
    return false
  if (left.kind === 'missing')
    return true
  return left.hash !== null && left.hash === right.hash
}

function sameWorkspaceState(
  left: WorkspaceSnapshotState | undefined,
  right: WorkspaceSnapshotState | undefined,
): boolean {
  if (!left || !right)
    return left === right
  return left.hash === right.hash && left.sizeBytes === right.sizeBytes
}

function emptyState(kind: 'missing' | 'unavailable'): CapturedFileStateRecord {
  return { hash: null, kind, redacted: false, sizeBytes: null, snapshotPath: null }
}

function requireGrant(grants: readonly DirectoryGrant[], grantId: string): DirectoryGrant {
  const grant = grants.find(candidate => candidate.grantId === grantId)
  if (!grant)
    throw new ChangeCaptureError('PATH_OUTSIDE_GRANTED_DIRECTORY')
  return grant
}

function readToolPath(value: unknown): string {
  const path = value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>).path
    : null
  if (typeof path !== 'string' || !path.trim())
    throw new ChangeCaptureError('VALIDATION_FAILED')
  return path
}

function resolvePreview(
  before: CapturedFileStateRecord,
  after: CapturedFileStateRecord,
): LocalFileChangeDetail['preview'] {
  const kinds = new Set([before.kind, after.kind])
  if (kinds.has('sensitive'))
    return 'sensitive'
  if (kinds.has('unavailable'))
    return 'unavailable'
  if (kinds.has('oversized'))
    return 'oversized'
  if (kinds.has('binary'))
    return 'binary'
  return 'text'
}

async function readSnapshot(state: CapturedFileStateRecord): Promise<string | null> {
  if (state.kind === 'missing')
    return ''
  if (state.kind !== 'text' || !state.snapshotPath)
    return null
  try {
    return await readFile(state.snapshotPath, 'utf8')
  }
  catch {
    return null
  }
}

function languageFromPath(path: string): string | null {
  return new Map([
    ['css', 'css'],
    ['html', 'html'],
    ['js', 'javascript'],
    ['json', 'javascript'],
    ['md', 'markdown'],
    ['py', 'python'],
    ['rs', 'rust'],
    ['scss', 'scss'],
    ['ts', 'typescript'],
    ['tsx', 'typescript'],
    ['vue', 'html'],
    ['xml', 'xml'],
    ['yaml', 'yaml'],
    ['yml', 'yaml'],
  ]).get(path.split('.').at(-1)?.toLowerCase() ?? '') ?? null
}

function toSummary(changeSet: ChangeSetRecord): LocalChangeSetSummary {
  return {
    changeSetId: changeSet.id,
    conversationId: changeSet.conversationId,
    coverage: changeSet.coverage,
    fileCount: changeSet.fileCount,
    runId: changeSet.runId,
    status: changeSet.status,
    updatedAt: changeSet.updatedAt,
  }
}

export class ChangeCaptureError extends Error {
  readonly code: string

  constructor(code: string) {
    super('Lexora Buddy change capture failed')
    this.name = 'ChangeCaptureError'
    this.code = code
  }
}
