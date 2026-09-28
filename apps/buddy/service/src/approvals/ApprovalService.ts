import type {
  ApprovalReuseScope,
  ApprovalReviewKind,
  AutomationApprovalReviewInput,
  BrowserApprovalReviewInput,
  PathApprovalReviewInput,
  ShellApprovalContext,
  SystemActionApprovalReviewInput,
} from '../../../shared/permissions/approvalReviewPayload'
import type { SandboxDirectoryRequest, SandboxNetworkTarget } from '../../../shared/permissions/shellSandbox'
import type { AppendBuddyRunEventInput } from '../events/BuddyRunEvent'
import type { ToolCallBlockingError } from '../permissions/permissionContract'
import type {
  ApprovalRecord,
  ApprovalRepository,
} from '../storage/approvalRepository'
import type { ApprovalAuthorizationKeys, ApprovalAuthorizationOverride } from './approvalAuthorization'
import { randomUUID } from 'node:crypto'
import { readDiagnosticErrorCode } from '../../../shared/diagnostics/applicationDiagnostic'
import { Emitter } from '../../../shared/events/Emitter'
import { copyEventSnapshot } from '../../../shared/events/eventSnapshot'
import { createApprovalReviewPayload } from '../../../shared/permissions/approvalReviewPayload'
import { approvalReuseScopes, createApprovalAuthorizationKeys } from './approvalAuthorization'

export const APPROVAL_WAIT_TIMEOUT_MS = 30 * 60 * 1_000

export type ApprovalDecision = 'approved' | 'denied'
export type ApprovalResolutionDecision = ApprovalDecision | `approved_for_${ApprovalReuseScope}`
export type ApprovalRequestResult
  = { approvalId: string, decision: 'approved_once' | `approved_for_${ApprovalReuseScope}` | 'denied' }
    | { decision: `approved_by_${ApprovalReuseScope}`, sourceApprovalId: string }

export interface ApprovalRequest {
  reuseScopes?: readonly ApprovalReuseScope[]
  arguments: unknown
  automation?: AutomationApprovalReviewInput
  browser?: BrowserApprovalReviewInput
  cwd?: string
  kind: ApprovalReviewKind
  network?: SandboxNetworkTarget
  sandboxDirectory?: SandboxDirectoryRequest
  paths?: PathApprovalReviewInput
  reuse?: ApprovalAuthorizationOverride
  shell?: ShellApprovalContext
  runId: string
  signal: AbortSignal
  runSignal?: AbortSignal
  summary: string
  systemAction?: SystemActionApprovalReviewInput
  toolCallId: string
  toolName: string
}

export interface ApprovalResolution {
  decision: ApprovalResolutionDecision
  id: string
}

export interface ApprovalServiceOptions {
  approvalTimeoutMs?: number
  eventLog: { append: (input: AppendBuddyRunEventInput) => Promise<unknown> }
  onExpired?: (runId: string) => Promise<void> | void
  repository: ApprovalRepository
  onObserverError?: (error: unknown) => void
}

type ApprovalCancellationReason = 'cancelled' | 'expired' | 'recovery' | 'shutdown'

export type ApprovalLifecycleFact = Readonly<
  | { kind: 'request.queued', requestId: string, runId: string, toolCallId: string }
  | { kind: 'request.released', requestId: string, runId: string, toolCallId: string, reason: 'started' | 'cancelled' | 'shutdown' }
  | { kind: 'waiter.started', approvalId: string, runId: string, toolCallId: string }
  | { kind: 'waiter.released', approvalId: string, runId: string, toolCallId: string, reason: ApprovalCancellationReason | 'approved' | 'denied' | 'request_failed', persistence: 'committed' | 'failed', durationMs: number }
  | { kind: 'authorization.established', approvalId: string, runId: string, scope: ApprovalReuseScope }
  | { kind: 'authorization.cleared', runId: string, reason: 'run_cancelled' | 'run_settled' | 'shutdown', count: number }
  | { kind: 'cancellation.failed', approvalId: string, runId: string, toolCallId: string, reason: ApprovalCancellationReason, errorCode: string }
>

interface ApprovalWaiter {
  startedAt: number
  authorizationSignal: AbortSignal
  authorizationKeys: ApprovalAuthorizationKeys
  reuseScopes: ReadonlySet<ApprovalReuseScope>
  cleanup: () => void
  reject: (error: Error) => void
  resolve: (decision: ApprovalRequestResult) => void
  signal: AbortSignal
}

export class ApprovalService {
  readonly #approvalTimeoutMs: number
  readonly #eventLog: ApprovalServiceOptions['eventLog']
  readonly #onExpired: NonNullable<ApprovalServiceOptions['onExpired']>
  readonly #repository: ApprovalRepository
  readonly #authorizations = new Map<ApprovalReuseScope, Map<string, Map<string, string>>>([
    ['operation', new Map()],
    ['source', new Map()],
    ['turn', new Map()],
  ])

  readonly #resolving = new Map<string, Promise<unknown>>()
  readonly #waiters = new Map<string, ApprovalWaiter>()
  readonly #queues = new Map<string, Promise<void>>()
  readonly #runLifetimes = new Map<string, () => void>()
  readonly #cancellations = new Set<Promise<void>>()
  readonly #lifecycle: Emitter<ApprovalLifecycleFact>
  readonly onDidChange: Emitter<ApprovalLifecycleFact>['event']
  #stopping = false
  #disposePromise: Promise<void> | null = null

  constructor(options: ApprovalServiceOptions) {
    this.#approvalTimeoutMs = options.approvalTimeoutMs ?? APPROVAL_WAIT_TIMEOUT_MS
    this.#eventLog = options.eventLog
    this.#onExpired = options.onExpired ?? (() => {})
    this.#repository = options.repository
    this.#lifecycle = new Emitter(options.onObserverError ?? (() => {}))
    this.onDidChange = this.#lifecycle.event
  }

  async request(input: ApprovalRequest): Promise<ApprovalRequestResult> {
    if (this.#stopping || input.signal.aborted)
      throw new ApprovalCancelledError()
    input = { ...input }
    const requestId = randomUUID()
    const previous = this.#queues.get(input.runId) ?? Promise.resolve()
    let started = false
    let released = false
    const release = (reason: 'started' | 'cancelled' | 'shutdown') => {
      if (released)
        return
      released = true
      input.signal.removeEventListener('abort', abort)
      this.#lifecycle.fire(copyEventSnapshot({ kind: 'request.released', requestId, runId: input.runId, toolCallId: input.toolCallId, reason }))
    }
    function abort() {
      release('cancelled')
    }
    const pending = previous.then(() => {
      started = true
      release(input.signal.aborted ? 'cancelled' : this.#stopping ? 'shutdown' : 'started')
      return this.#request(input)
    })
    const settled = pending.then(() => {}, () => {})
    this.#queues.set(input.runId, settled)
    input.signal.addEventListener('abort', abort, { once: true })
    this.#lifecycle.fire(copyEventSnapshot({ kind: 'request.queued', requestId, runId: input.runId, toolCallId: input.toolCallId }))
    void settled.then(() => {
      if (this.#queues.get(input.runId) === settled)
        this.#queues.delete(input.runId)
    })
    return waitForApproval(pending, input.signal, () => started)
  }

  async #request(input: ApprovalRequest): Promise<ApprovalRequestResult> {
    if (this.#stopping || input.signal.aborted)
      throw new ApprovalCancelledError()
    const authorizationKeys = createApprovalAuthorizationKeys(input, input.reuse)
    const reuseScopes = approvalReuseScopes(authorizationKeys, input.reuseScopes)
    const reused = this.#findAuthorization(input.runId, reuseScopes, authorizationKeys)
    if (reused) {
      await this.#eventLog.append({
        runId: input.runId,
        type: 'approval.reused',
        payload: {
          scope: reused.scope,
          sourceApprovalId: reused.sourceApprovalId,
          toolCallId: input.toolCallId,
          toolName: input.toolName,
        },
      })
      return {
        decision: `approved_by_${reused.scope}`,
        sourceApprovalId: reused.sourceApprovalId,
      }
    }

    const approval: ApprovalRecord = {
      createdAt: new Date().toISOString(),
      id: randomUUID(),
      kind: input.kind,
      payload: createApprovalReviewPayload({
        allowForTurn: reuseScopes.includes('turn'),
        arguments: input.arguments,
        automation: input.automation,
        browser: input.browser,
        kind: input.kind,
        network: input.network,
        sandboxDirectory: input.sandboxDirectory,
        paths: input.paths,
        reuseScopes,
        shell: input.shell,
        systemAction: input.systemAction,
        toolName: input.toolName,
      }),
      resolvedAt: null,
      runId: input.runId,
      status: 'pending',
      summary: input.summary,
      toolCallId: input.toolCallId,
    }
    const abort = () => this.#scheduleCancellation(approval, 'cancelled')
    const expire = () => this.#scheduleCancellation(approval, 'expired')
    let timer: ReturnType<typeof setTimeout> | null = null
    const decision = new Promise<ApprovalRequestResult>((resolve, reject) => {
      this.#waiters.set(approval.id, {
        startedAt: Date.now(),
        authorizationSignal: input.runSignal ?? input.signal,
        authorizationKeys,
        cleanup: () => {
          if (timer)
            clearTimeout(timer)
          input.signal.removeEventListener('abort', abort)
        },
        reject,
        reuseScopes: new Set(reuseScopes),
        resolve,
        signal: input.signal,
      })
    })
    void decision.catch(() => {})
    input.signal.addEventListener('abort', abort, { once: true })
    this.#lifecycle.fire(copyEventSnapshot({ kind: 'waiter.started', approvalId: approval.id, runId: approval.runId, toolCallId: approval.toolCallId }))
    try {
      await this.#appendRequested(approval)
      this.#requireApproval(approval.id)
      if (!this.#stopping && !input.signal.aborted && this.#waiters.has(approval.id)) {
        timer = setTimeout(expire, this.#approvalTimeoutMs)
        timer.unref?.()
      }
    }
    catch (error) {
      const waiter = this.#waiters.get(approval.id)
      waiter?.reject(asError(error))
      this.#releaseWaiter(approval, 'request_failed', 'failed')
      throw error
    }
    if (this.#stopping || input.signal.aborted) {
      await this.#cancel(approval, this.#stopping ? 'shutdown' : 'cancelled')
      return decision
    }
    return decision
  }

  async resolve(input: ApprovalResolution): Promise<ApprovalRecord> {
    if (this.#stopping || this.#resolving.has(input.id))
      throw new ApprovalResolutionError()
    return this.#trackResolution(input.id, this.#resolvePending(input))
  }

  clearRunAuthorizations(runId: string, reason: 'run_cancelled' | 'run_settled' | 'shutdown' = 'run_settled'): void {
    this.#runLifetimes.get(runId)?.()
    this.#runLifetimes.delete(runId)
    let count = 0
    for (const authorizations of this.#authorizations.values()) {
      count += authorizations.get(runId)?.size ?? 0
      authorizations.delete(runId)
    }
    if (count)
      this.#lifecycle.fire(copyEventSnapshot({ kind: 'authorization.cleared', runId, reason, count }))
  }

  async #resolvePending(input: ApprovalResolution): Promise<ApprovalRecord> {
    const pending = this.#requireApproval(input.id)
    if (pending.status !== 'pending')
      throw new ApprovalResolutionError()
    const waiter = this.#waiters.get(input.id)
    const approvedScope = readApprovedScope(input.decision)
    if (approvedScope && !waiter?.reuseScopes.has(approvedScope))
      throw new ApprovalResolutionError()
    const decision: ApprovalDecision = input.decision === 'denied' ? 'denied' : 'approved'
    const resolvedAt = new Date().toISOString()
    await this.#appendResolved({
      ...pending,
      resolvedAt,
      status: decision,
      resolution: input.decision,
    })
    const approval = this.#requireApproval(input.id)
    if (approval.status !== decision)
      throw new ApprovalResolutionError()
    if (approvedScope && waiter && !this.#stopping && !waiter.signal.aborted && !waiter.authorizationSignal.aborted) {
      this.#storeAuthorization(
        approvedScope,
        pending.runId,
        approvedScope === 'turn' ? pending.runId : waiter.authorizationKeys[approvedScope]!,
        pending.id,
      )
      if (!this.#runLifetimes.has(pending.runId)) {
        const clear = () => this.clearRunAuthorizations(pending.runId, 'run_cancelled')
        waiter.authorizationSignal.addEventListener('abort', clear, { once: true })
        this.#runLifetimes.set(pending.runId, () => waiter.authorizationSignal.removeEventListener('abort', clear))
      }
      this.#lifecycle.fire(copyEventSnapshot({ kind: 'authorization.established', approvalId: pending.id, runId: pending.runId, scope: approvedScope }))
    }
    waiter?.resolve({
      approvalId: pending.id,
      decision: approvedScope
        ? `approved_for_${approvedScope}`
        : decision === 'approved'
          ? 'approved_once'
          : 'denied',
    })
    this.#releaseWaiter(pending, decision, 'committed')
    return approval
  }

  async cancelPendingApprovals(reason: 'recovery' | 'shutdown' = 'recovery'): Promise<number> {
    let cancelled = 0
    for (const approval of this.#repository.listPending()) {
      await this.#cancel(approval, reason)
      cancelled += 1
    }
    return cancelled
  }

  async #cancel(approval: ApprovalRecord, reason: ApprovalCancellationReason): Promise<void> {
    const resolving = this.#resolving.get(approval.id)
    if (resolving) {
      await resolving.catch(() => {})
      return this.#cancel(approval, reason)
    }
    const pending = this.#repository.findById(approval.id)
    if (!pending || pending.status !== 'pending')
      return
    await this.#trackResolution(approval.id, this.#cancelPending(pending, reason))
    if (reason === 'expired')
      await this.#onExpired(approval.runId)
  }

  #scheduleCancellation(approval: ApprovalRecord, reason: ApprovalCancellationReason): void {
    const operation = this.#cancel(approval, reason)
    this.#cancellations.add(operation)
    void operation.then(() => this.#cancellations.delete(operation), (error) => {
      this.#cancellations.delete(operation)
      this.#lifecycle.fire(copyEventSnapshot({ kind: 'cancellation.failed', approvalId: approval.id, runId: approval.runId, toolCallId: approval.toolCallId, reason, errorCode: readDiagnosticErrorCode(error) }))
    })
  }

  async #cancelPending(approval: ApprovalRecord, reason: ApprovalCancellationReason): Promise<void> {
    const resolvedAt = new Date().toISOString()
    const waiter = this.#waiters.get(approval.id)
    let persistence: 'committed' | 'failed' = 'failed'
    try {
      await this.#appendResolved({
        ...approval,
        resolvedAt,
        status: 'cancelled',
        resolution: 'cancelled',
      })
      persistence = 'committed'
      waiter?.reject(reason === 'expired' ? new ApprovalExpiredError() : new ApprovalCancelledError())
    }
    catch (error) {
      waiter?.reject(asError(error))
      throw error
    }
    finally {
      this.#releaseWaiter(approval, reason, persistence)
    }
  }

  dispose(): Promise<void> {
    if (this.#disposePromise)
      return this.#disposePromise
    this.#stopping = true
    this.#disposePromise = this.#dispose()
    return this.#disposePromise
  }

  async #dispose(): Promise<void> {
    const failures: unknown[] = []
    try {
      const cancelled = await Promise.allSettled(this.#repository.listPending().map(approval => this.#cancel(approval, 'shutdown')))
      failures.push(...cancelled.flatMap(result => result.status === 'rejected' ? [result.reason] : []))
      await Promise.allSettled(this.#queues.values())
      await Promise.allSettled(this.#resolving.values())
      const cancellations = await Promise.allSettled(this.#cancellations)
      failures.push(...cancellations.flatMap(result => result.status === 'rejected' ? [result.reason] : []))
    }
    finally {
      const runIds = new Set([...this.#authorizations.values()].flatMap(authorizations => [...authorizations.keys()]))
      for (const runId of runIds)
        this.clearRunAuthorizations(runId, 'shutdown')
      this.#lifecycle.dispose()
    }
    if (failures.length)
      throw new AggregateError(failures, 'Lexora Buddy approval shutdown could not persist every cancellation')
  }

  #releaseWaiter(approval: ApprovalRecord, reason: Extract<ApprovalLifecycleFact, { kind: 'waiter.released' }>['reason'], persistence: 'committed' | 'failed'): void {
    const waiter = this.#waiters.get(approval.id)
    if (!waiter)
      return
    waiter.cleanup()
    this.#waiters.delete(approval.id)
    this.#lifecycle.fire(copyEventSnapshot({ kind: 'waiter.released', approvalId: approval.id, runId: approval.runId, toolCallId: approval.toolCallId, reason, persistence, durationMs: Math.max(0, Date.now() - waiter.startedAt) }))
  }

  #trackResolution<T>(id: string, operation: Promise<T>): Promise<T> {
    const tracked = operation.finally(() => {
      if (this.#resolving.get(id) === tracked)
        this.#resolving.delete(id)
    })
    this.#resolving.set(id, tracked)
    return tracked
  }

  #appendRequested(approval: ApprovalRecord): Promise<unknown> {
    return this.#eventLog.append({
      runId: approval.runId,
      type: 'approval.requested',
      payload: approval,
    })
  }

  #appendResolved(
    approval: ApprovalRecord & { resolution: ApprovalResolutionDecision | 'cancelled' },
  ): Promise<unknown> {
    return this.#eventLog.append({
      runId: approval.runId,
      type: 'approval.resolved',
      payload: {
        id: approval.id,
        resolution: approval.resolution,
        status: approval.status,
        resolvedAt: approval.resolvedAt,
      },
    })
  }

  #requireApproval(id: string): ApprovalRecord {
    const approval = this.#repository.findById(id)
    if (!approval)
      throw new ApprovalResolutionError()
    return approval
  }

  #findAuthorization(
    runId: string,
    scopes: readonly ApprovalReuseScope[],
    keys: ApprovalAuthorizationKeys,
  ): { scope: ApprovalReuseScope, sourceApprovalId: string } | null {
    for (const scope of scopes) {
      const key = scope === 'turn' ? runId : keys[scope]
      if (!key)
        continue
      const sourceApprovalId = this.#authorizations.get(scope)?.get(runId)?.get(key)
      if (sourceApprovalId)
        return { scope, sourceApprovalId }
    }
    return null
  }

  #storeAuthorization(
    scope: ApprovalReuseScope,
    runId: string,
    key: string,
    sourceApprovalId: string,
  ): void {
    const authorizations = this.#authorizations.get(scope)!
    const runAuthorizations = authorizations.get(runId) ?? new Map<string, string>()
    runAuthorizations.set(key, sourceApprovalId)
    authorizations.set(runId, runAuthorizations)
  }
}

function readApprovedScope(decision: ApprovalResolutionDecision): ApprovalReuseScope | null {
  if (!decision.startsWith('approved_for_'))
    return null
  const scope = decision.slice('approved_for_'.length)
  return scope === 'operation' || scope === 'source' || scope === 'turn' ? scope : null
}

function waitForApproval<T>(pending: Promise<T>, signal: AbortSignal, started: () => boolean): Promise<T> {
  if (signal.aborted)
    return Promise.reject(new ApprovalCancelledError())
  return new Promise((resolve, reject) => {
    const abort = () => {
      if (!started())
        reject(new ApprovalCancelledError())
    }
    signal.addEventListener('abort', abort, { once: true })
    void pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

export class ApprovalCancelledError extends Error implements ToolCallBlockingError {
  readonly code = 'APPROVAL_CANCELLED'
  readonly toolCallBlockReason = this.code

  constructor() {
    super('Lexora Buddy approval was cancelled')
    this.name = 'ApprovalCancelledError'
  }
}

export class ApprovalExpiredError extends Error implements ToolCallBlockingError {
  readonly code = 'AUTOMATION_APPROVAL_EXPIRED'
  readonly toolCallBlockReason = this.code

  constructor() {
    super('Lexora Buddy approval expired')
    this.name = 'ApprovalExpiredError'
  }
}

export class ApprovalResolutionError extends Error {
  readonly code = 'APPROVAL_NOT_PENDING'

  constructor() {
    super('Lexora Buddy approval is not pending')
    this.name = 'ApprovalResolutionError'
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error('Lexora Buddy approval failed')
}
