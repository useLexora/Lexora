import type { SystemActionApprovalReviewInput } from '../../../shared/permissions/approvalReviewPayload'
import { randomUUID } from 'node:crypto'
import { readDiagnosticErrorCode } from '../../../shared/diagnostics/applicationDiagnostic'
import { Emitter } from '../../../shared/events/Emitter'
import { copyEventSnapshot } from '../../../shared/events/eventSnapshot'

export const SYSTEM_ACTION_KINDS = [
  'kill-process',
  'restart-service',
  'start-service',
  'stop-service',
  'terminate-process',
] as const

export type SystemActionKind = typeof SYSTEM_ACTION_KINDS[number]
export type SystemInterruption = 'application' | 'network' | 'none' | 'service'

interface SystemTargetBase {
  allowedActions: readonly SystemActionKind[]
  displayName: string
  interruption: SystemInterruption
}

export interface ProcessSystemTarget extends SystemTargetBase {
  executable: string | null
  kind: 'process'
  pid: number
  startedAt: string
  instanceId: string
}

export interface ServiceSystemTarget extends SystemTargetBase {
  activeState: string
  displayId: string
  kind: 'service'
  scope: 'user' | 'system'
  serviceId: string
}

export type SystemTarget = ProcessSystemTarget | ServiceSystemTarget

export type ProcessSystemTargetSelector
  = | { kind: 'process', name: string }
    | { kind: 'process', pid: number }

export interface ServiceSystemTargetSelector {
  kind: 'service'
  scope: 'user' | 'system'
  serviceId: string
}

export type SystemTargetSelector = ProcessSystemTargetSelector | ServiceSystemTargetSelector

interface SystemActionRequestBase {
  reason: string
}

export interface ProcessSystemActionRequest extends SystemActionRequestBase {
  action: 'kill-process' | 'terminate-process'
  target: ProcessSystemTargetSelector
}

export interface ServiceSystemActionRequest extends SystemActionRequestBase {
  action: 'restart-service' | 'start-service' | 'stop-service'
  target: ServiceSystemTargetSelector
}

export type SystemActionRequest = ProcessSystemActionRequest | ServiceSystemActionRequest

export interface SystemHostPort {
  execute: (
    target: SystemTarget,
    action: SystemActionKind,
    signal: AbortSignal,
  ) => Promise<void>
  readTarget: (
    target: SystemTarget,
    signal: AbortSignal,
  ) => Promise<SystemTarget | null>
  resolveTargets: (
    selector: SystemTargetSelector,
    signal: AbortSignal,
  ) => Promise<readonly SystemTarget[]>
}

export interface PreparedSystemAction {
  review: SystemActionApprovalReviewInput
  summary: string
}

interface PreparedSystemActionEntry {
  preparationId: string
  expiresAt: number
  request: SystemActionRequest
  target: SystemTarget
}

export interface SystemActionPreparationRegistryOptions {
  maxEntries?: number
  now?: () => number
  ttlMs?: number
}

export interface SystemPreparationChange {
  readonly revision: number
  readonly preparationId: string
  readonly toolCallId: string
  readonly phase: 'prepared' | 'removed'
  readonly reason?: 'consumed' | 'expired' | 'evicted' | 'changed' | 'disposed'
  readonly action: SystemActionKind
  readonly targetKind: SystemTarget['kind']
}

export class SystemActionPreparationRegistry {
  readonly #changes = new Emitter<SystemPreparationChange>(() => console.error('SYSTEM_PREPARATION_OBSERVER_FAILED'))
  readonly onDidChange = this.#changes.event
  #revision = 0
  #disposed = false
  readonly #entries = new Map<string, PreparedSystemActionEntry>()
  readonly #maxEntries: number
  readonly #now: () => number
  readonly #ttlMs: number

  constructor(options: SystemActionPreparationRegistryOptions = {}) {
    this.#maxEntries = options.maxEntries ?? 512
    this.#now = options.now ?? Date.now
    this.#ttlMs = options.ttlMs ?? 5 * 60 * 1_000
  }

  get snapshot() {
    return copyEventSnapshot({ revision: this.#revision, prepared: [...this.#entries].map(([toolCallId, entry]) => ({ toolCallId, preparationId: entry.preparationId, expiresAt: entry.expiresAt, action: entry.request.action, targetKind: entry.target.kind })) })
  }

  prepare(
    toolCallId: string,
    request: SystemActionRequest,
    target: SystemTarget,
  ): PreparedSystemAction {
    if (this.#disposed)
      throw new Error('SYSTEM_PREPARATION_STOPPED')
    this.#prune()
    const existing = this.#entries.get(toolCallId)
    if (existing) {
      if (!sameRequest(existing.request, request) || !sameTargetIdentity(existing.target, target))
        throw new SystemCapabilityError('SYSTEM_ACTION_CHANGED')
      return createPreparedSystemAction(existing)
    }
    const entry: PreparedSystemActionEntry = {
      preparationId: randomUUID(),
      expiresAt: this.#now() + this.#ttlMs,
      request: cloneRequest(request),
      target: cloneTarget(target),
    }
    this.#entries.set(toolCallId, entry)
    this.#publish(toolCallId, entry, 'prepared')
    while (this.#entries.size > this.#maxEntries) {
      const oldest = this.#entries.keys().next().value
      if (typeof oldest !== 'string')
        break
      this.#remove(oldest, 'evicted')
    }
    return createPreparedSystemAction(entry)
  }

  take(toolCallId: string, request: SystemActionRequest): SystemTarget {
    const entry = this.#entries.get(toolCallId)
    if (!entry)
      throw new SystemCapabilityError('SYSTEM_ACTION_NOT_PREPARED')
    if (entry.expiresAt <= this.#now()) {
      this.#remove(toolCallId, 'expired')
      throw new SystemCapabilityError('SYSTEM_ACTION_EXPIRED')
    }
    if (!sameRequest(entry.request, request)) {
      this.#remove(toolCallId, 'changed')
      throw new SystemCapabilityError('SYSTEM_ACTION_CHANGED')
    }
    this.#remove(toolCallId, 'consumed')
    return cloneTarget(entry.target)
  }

  dispose(): void {
    if (this.#disposed)
      return
    this.#disposed = true
    for (const toolCallId of this.#entries.keys())
      this.#remove(toolCallId, 'disposed')
    this.#changes.dispose()
  }

  #remove(toolCallId: string, reason: SystemPreparationChange['reason']): void {
    const entry = this.#entries.get(toolCallId)
    if (!entry)
      return
    this.#entries.delete(toolCallId)
    this.#publish(toolCallId, entry, 'removed', reason)
  }

  #publish(toolCallId: string, entry: PreparedSystemActionEntry, phase: SystemPreparationChange['phase'], reason?: SystemPreparationChange['reason']): void {
    this.#changes.fire(copyEventSnapshot({ revision: ++this.#revision, toolCallId, preparationId: entry.preparationId, phase, ...(reason ? { reason } : {}), action: entry.request.action, targetKind: entry.target.kind }))
  }

  #prune(): void {
    const now = this.#now()
    for (const [toolCallId, entry] of this.#entries) {
      if (entry.expiresAt <= now)
        this.#remove(toolCallId, 'expired')
    }
  }
}

export interface SystemCapabilityServiceOptions {
  actions?: SystemActionPreparationRegistry
  host: SystemHostPort
}

export interface SystemActionChange {
  readonly revision: number
  readonly operationId: string
  readonly toolCallId: string
  readonly action: SystemActionKind
  readonly targetKind: SystemTarget['kind']
  readonly phase: 'dispatched' | 'confirmed' | 'verified' | 'failed'
  readonly effect: 'not-dispatched' | 'unknown' | 'confirmed'
  readonly verified?: boolean
  readonly errorCode?: string
  readonly cancelled: boolean
}

export class SystemCapabilityService {
  readonly #changes = new Emitter<SystemActionChange>(() => console.error('SYSTEM_ACTION_OBSERVER_FAILED'))
  readonly onDidChange = this.#changes.event
  readonly #actions: SystemActionPreparationRegistry
  readonly #ownsActions: boolean
  readonly #host: SystemHostPort
  readonly #shutdown = new AbortController()
  readonly #pending = new Set<Promise<unknown>>()
  #revision = 0
  #disposing: Promise<void> | undefined

  constructor(options: SystemCapabilityServiceOptions) {
    this.#actions = options.actions ?? new SystemActionPreparationRegistry()
    this.#ownsActions = !options.actions
    this.#host = options.host
  }

  get onDidChangePreparation() { return this.#actions.onDidChange }
  get snapshot() { return copyEventSnapshot({ revision: this.#revision, stopping: this.#shutdown.signal.aborted, pending: this.#pending.size, preparations: this.#actions.snapshot }) }

  prepareAction(toolCallId: string, input: SystemActionRequest, parent: AbortSignal): Promise<PreparedSystemAction> {
    const request = cloneRequest(input)
    const signal = AbortSignal.any([parent, this.#shutdown.signal])
    return this.#track(async () => {
      signal.throwIfAborted()
      validateActionRequest(request)
      const targets = await this.#host.resolveTargets(request.target, signal)
      signal.throwIfAborted()
      if (targets.length === 0)
        throw new SystemCapabilityError('SYSTEM_TARGET_NOT_FOUND')
      if (targets.length > 1)
        throw new SystemCapabilityError('SYSTEM_TARGET_AMBIGUOUS')
      const target = targets[0]!
      if (!target.allowedActions.includes(request.action))
        throw new SystemCapabilityError('SYSTEM_ACTION_NOT_ALLOWED')
      return this.#actions.prepare(toolCallId, request, target)
    })
  }

  act(toolCallId: string, input: SystemActionRequest, parent: AbortSignal) {
    const request = cloneRequest(input)
    const signal = AbortSignal.any([parent, this.#shutdown.signal])
    const operationId = randomUUID()
    return this.#track(async () => {
      let effect: SystemActionChange['effect'] = 'not-dispatched'
      const publish = (phase: SystemActionChange['phase'], detail: Pick<SystemActionChange, 'verified' | 'errorCode'> = {}) => {
        this.#changes.fire(copyEventSnapshot({ ...detail, revision: ++this.#revision, operationId, toolCallId, action: request.action, targetKind: request.target.kind, phase, effect, cancelled: signal.aborted }))
      }
      try {
        signal.throwIfAborted()
        validateActionRequest(request)
        const approvedTarget = this.#actions.take(toolCallId, request)
        const current = await this.#host.readTarget(approvedTarget, signal)
        signal.throwIfAborted()
        if (!current || !sameTargetIdentity(approvedTarget, current))
          throw new SystemCapabilityError('SYSTEM_TARGET_CHANGED')
        if (!current.allowedActions.includes(request.action))
          throw new SystemCapabilityError('SYSTEM_ACTION_NOT_ALLOWED')
        effect = 'unknown'
        publish('dispatched')
        await this.#host.execute(current, request.action, signal)
        effect = 'confirmed'
        publish('confirmed')
        const postAction = await this.#host.readTarget(current, signal)
        const outcome = evaluatePostcondition(request.action, current, postAction)
        publish('verified', { verified: outcome.verified })
        return { action: request.action, message: outcome.message, observedAt: new Date().toISOString(), status: outcome.status, target: targetReview(current), verified: outcome.verified }
      }
      catch (error) {
        publish('failed', { errorCode: readDiagnosticErrorCode(error) })
        throw error
      }
    })
  }

  dispose(): Promise<void> {
    this.#disposing ??= Promise.resolve().then(async () => {
      await Promise.allSettled([...this.#pending])
      if (this.#ownsActions)
        this.#actions.dispose()
      this.#changes.dispose()
    })
    this.#shutdown.abort()
    return this.#disposing
  }

  #track<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#shutdown.signal.aborted)
      return Promise.reject(this.#shutdown.signal.reason)
    const pending = Promise.resolve().then(operation)
    this.#pending.add(pending)
    void pending.finally(() => this.#pending.delete(pending)).catch(() => {})
    return pending
  }
}

export type SystemCapabilityErrorCode
  = 'SYSTEM_ACCESS_DENIED'
    | 'SYSTEM_ACTION_CHANGED'
    | 'SYSTEM_ACTION_EXPIRED'
    | 'SYSTEM_ACTION_INVALID'
    | 'SYSTEM_ACTION_NOT_ALLOWED'
    | 'SYSTEM_ACTION_NOT_PREPARED'
    | 'SYSTEM_TARGET_AMBIGUOUS'
    | 'SYSTEM_TARGET_CHANGED'
    | 'SYSTEM_TARGET_NOT_FOUND'

export class SystemCapabilityError extends Error {
  readonly code: SystemCapabilityErrorCode

  constructor(code: SystemCapabilityErrorCode) {
    super('Lexora Buddy system capability could not complete the request')
    this.name = 'SystemCapabilityError'
    this.code = code
  }
}

function validateActionRequest(input: SystemActionRequest): void {
  const reason = input.reason.trim()
  if (!reason || reason.length > 512)
    throw new SystemCapabilityError('SYSTEM_ACTION_INVALID')
  if (input.target.kind === 'process') {
    if (input.action !== 'terminate-process' && input.action !== 'kill-process')
      throw new SystemCapabilityError('SYSTEM_ACTION_INVALID')
    if ('pid' in input.target) {
      if (!Number.isSafeInteger(input.target.pid) || input.target.pid <= 1)
        throw new SystemCapabilityError('SYSTEM_ACTION_INVALID')
      return
    }
    if (!input.target.name.trim() || input.target.name.length > 256)
      throw new SystemCapabilityError('SYSTEM_ACTION_INVALID')
    return
  }
  if (input.action !== 'start-service'
    && input.action !== 'stop-service'
    && input.action !== 'restart-service') {
    throw new SystemCapabilityError('SYSTEM_ACTION_INVALID')
  }
  if (!['user', 'system'].includes(input.target.scope)
    || !input.target.serviceId.trim()
    || [...input.target.serviceId].some(character => character.charCodeAt(0) < 32)
    || input.target.serviceId.length > 256) {
    throw new SystemCapabilityError('SYSTEM_ACTION_INVALID')
  }
}

function sameTargetIdentity(expected: SystemTarget, current: SystemTarget): boolean {
  if (expected.kind !== current.kind)
    return false
  if (expected.kind === 'process' && current.kind === 'process') {
    return expected.pid === current.pid
      && expected.instanceId === current.instanceId
      && expected.executable === current.executable
  }
  return expected.kind === 'service'
    && current.kind === 'service'
    && expected.scope === current.scope
    && expected.serviceId === current.serviceId
}

function sameRequest(expected: SystemActionRequest, current: SystemActionRequest): boolean {
  if (expected.action !== current.action || expected.reason !== current.reason)
    return false
  if (expected.target.kind !== current.target.kind)
    return false
  if (expected.target.kind === 'service' && current.target.kind === 'service') {
    return expected.target.scope === current.target.scope
      && expected.target.serviceId === current.target.serviceId
  }
  if (expected.target.kind !== 'process' || current.target.kind !== 'process')
    return false
  if ('pid' in expected.target || 'pid' in current.target) {
    return 'pid' in expected.target
      && 'pid' in current.target
      && expected.target.pid === current.target.pid
  }
  return expected.target.name === current.target.name
}

function evaluatePostcondition(
  action: SystemActionKind,
  target: SystemTarget,
  postAction: SystemTarget | null,
): { message: string, status: 'completed' | 'failed' | 'needs-escalation', verified: boolean } {
  if (target.kind === 'process') {
    if (!postAction || !sameTargetIdentity(target, postAction)) {
      return {
        message: 'The approved process identity is no longer running',
        status: 'completed',
        verified: true,
      }
    }
    if (action === 'terminate-process') {
      return {
        message: 'The process is still running after the graceful termination request',
        status: 'needs-escalation',
        verified: false,
      }
    }
    return {
      message: 'The process is still running after the force termination request',
      status: 'failed',
      verified: false,
    }
  }
  if (!postAction || postAction.kind !== 'service') {
    return {
      message: 'The service state could not be verified after the action',
      status: 'failed',
      verified: false,
    }
  }
  const expectedActive = action === 'start-service' || action === 'restart-service'
  const verified = expectedActive
    ? postAction.activeState === 'active'
    : postAction.activeState === 'inactive' || postAction.activeState === 'failed'
  return {
    message: verified
      ? `The service state was verified as ${postAction.activeState}`
      : `The service state is ${postAction.activeState}`,
    status: verified ? 'completed' : 'failed',
    verified,
  }
}

function createPreparedSystemAction(entry: PreparedSystemActionEntry): PreparedSystemAction {
  return {
    review: {
      action: entry.request.action,
      effect: describeEffect(entry.request.action),
      expiresAt: new Date(entry.expiresAt).toISOString(),
      interruption: entry.target.interruption,
      reason: entry.request.reason.trim(),
      target: targetReview(entry.target),
    },
    summary: describeSummary(entry.request.action, entry.target),
  }
}

function targetReview(target: SystemTarget): SystemActionApprovalReviewInput['target'] {
  return target.kind === 'process'
    ? {
        displayName: target.displayName,
        pid: target.pid,
        startedAt: target.startedAt,
      }
    : {
        displayName: target.displayName,
        serviceId: target.displayId,
      }
}

function describeEffect(action: SystemActionKind): string {
  switch (action) {
    case 'terminate-process':
      return 'Ask the process to exit gracefully'
    case 'kill-process':
      return 'Force the process to stop immediately'
    case 'restart-service':
      return 'Stop and start the service'
    case 'start-service':
      return 'Start the service'
    case 'stop-service':
      return 'Stop the service'
  }
}

function describeSummary(action: SystemActionKind, target: SystemTarget): string {
  return `${describeEffect(action)}: ${target.displayName}`
}

function cloneRequest(request: SystemActionRequest): SystemActionRequest {
  switch (request.action) {
    case 'kill-process':
    case 'terminate-process':
      return { ...request, target: { ...request.target } }
    case 'restart-service':
    case 'start-service':
    case 'stop-service':
      return { ...request, target: { ...request.target } }
  }
}

function cloneTarget(target: SystemTarget): SystemTarget {
  return { ...target, allowedActions: [...target.allowedActions] }
}
