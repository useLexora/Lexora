import type {
  BrowserAcquireControlParams,
  BrowserAcquireControlResult,
  BrowserActParams,
  BrowserActResult,
  BrowserCapabilityActParams,
  BrowserCloseResult,
  BrowserErrorCode,
  BrowserObservation,
  BrowserObservedElement,
  BrowserObserveParams,
  BrowserObserveResult,
  BrowserOpenResult,
  BrowserReleaseControlParams,
  BrowserReleaseControlResult,
  BrowserStateResult,
  BrowserValidateActionParams,
  BrowserValidateActionResult,
  BrowserWaitSpec,
} from '../../../shared/browser'
import type { BrowserApprovalReviewInput } from '../../../shared/permissions/approvalReviewPayload'
import type { BrowserActionClassification } from '../approvals/browser/classifyBrowserAction'
import type { DirectoryGrant } from '../directories/resolveGrantedPath'
import type {
  OpenBrowserLocalInput,
  OpenBrowserUrlInput,
} from './BrowserHostClient'
import { createHash, randomUUID } from 'node:crypto'
import { getBrowserActionRef } from '../../../shared/browser'
import { Emitter } from '../../../shared/events/Emitter'
import { copyEventSnapshot } from '../../../shared/events/eventSnapshot'
import { classifyBrowserAction } from '../approvals/browser/classifyBrowserAction'

export type BrowserCapabilityOpenTarget = {
  kind: 'url'
  until?: BrowserWaitSpec
  url: string
} | {
  entryPath: string
  kind: 'local-file'
  until?: BrowserWaitSpec
}

export interface BrowserCapabilityObserveInput {
  maxElements?: number
}

export type BrowserCapabilityActInput = BrowserCapabilityActParams

export type BrowserCapabilityActionClassificationResult
  = (BrowserActionClassification & {
    approvalReview?: BrowserApprovalReviewInput
  })
  | { blocked: true, reason: 'BROWSER_TARGET_STALE' }

export type BrowserActionApprovalValidationResult
  = { blocked: true, reason: BrowserErrorCode }
    | null

export interface BrowserCapabilityHost {
  acquireControl: (
    input: BrowserAcquireControlParams,
  ) => Promise<BrowserAcquireControlResult>
  act: (input: BrowserActParams) => Promise<BrowserActResult>
  close: (sessionId: string) => Promise<BrowserCloseResult>
  getState: (sessionId: string) => Promise<BrowserStateResult>
  observe: (input: BrowserObserveParams) => Promise<BrowserObserveResult>
  openLocal: (input: OpenBrowserLocalInput) => Promise<BrowserOpenResult>
  openUrl: (input: OpenBrowserUrlInput) => Promise<BrowserOpenResult>
  releaseControl: (
    input: BrowserReleaseControlParams,
  ) => Promise<BrowserReleaseControlResult>
  validateAction: (
    input: BrowserValidateActionParams,
  ) => Promise<BrowserValidateActionResult>
}

export interface BrowserCapabilityServiceOptions {
  getExecutionGrants?: (toolCallId: string) => readonly DirectoryGrant[]
  conversationId: string
  getGrants: () => readonly DirectoryGrant[]
  host: BrowserCapabilityHost
}

type BrowserFailure = Extract<BrowserStateResult, { ok: false }>

interface BrowserPolicyObservation {
  documentRevision: number
  elements: ReadonlyMap<string, BrowserObservedElement>
  observationContainsHumanInput: boolean
  observationId: string
  pageId: string
  sessionId: string
  url: BrowserObservation['url']
}

export type BrowserCapabilityChange = {
  readonly revision: number
  readonly kind: 'binding' | 'policy'
  readonly sessionId: string | null
  readonly pageId: string | null
  readonly observationId: string | null
  readonly documentRevision: number | null
  readonly count: number
} | {
  readonly revision: number
  readonly kind: 'action' | 'control'
  readonly operationId: string
  readonly phase: 'dispatched' | 'response-received' | 'response-unknown' | 'caller-settled' | 'acquired' | 'released' | 'release-unknown'
  readonly cancelled: boolean
  readonly accepted?: boolean
  readonly controlEpoch?: number
}

export class BrowserCapabilityService {
  readonly #changes = new Emitter<BrowserCapabilityChange>(() => console.error('BROWSER_CAPABILITY_OBSERVER_FAILED'))
  readonly onDidChange = this.#changes.event
  readonly #shutdown = new AbortController()
  readonly #pending = new Set<Promise<unknown>>()
  #revision = 0
  #disposing: Promise<void> | undefined
  readonly #conversationId: string
  readonly #getGrants: () => readonly DirectoryGrant[]
  readonly #host: BrowserCapabilityHost
  #policyObservation: BrowserPolicyObservation | null = null
  #sessionId: string | null = null

  constructor(options: BrowserCapabilityServiceOptions) {
    this.#conversationId = options.conversationId
    this.#getGrants = options.getGrants
    this.#host = options.host
  }

  get snapshot() { return copyEventSnapshot({ revision: this.#revision, stopping: this.#shutdown.signal.aborted, pending: this.#pending.size, ...this.#binding() }) }

  open(target: BrowserCapabilityOpenTarget, grants = this.#getGrants()): Promise<BrowserOpenResult> {
    const captured = copyEventSnapshot(target)
    const capturedGrants = grants.map(cloneGrant)
    return this.#track(() => this.#open(captured, capturedGrants))
  }

  async #open(target: BrowserCapabilityOpenTarget, grants: readonly DirectoryGrant[]): Promise<BrowserOpenResult> {
    this.#setPolicy(null)
    const result = target.kind === 'url'
      ? await this.#host.openUrl({
          conversationId: this.#conversationId,
          ...(target.until ? { until: target.until } : {}),
          url: target.url,
        })
      : await this.#host.openLocal({
          conversationId: this.#conversationId,
          entryPath: target.entryPath,
          grants: grants.map(cloneGrant),
          ...(target.until ? { until: target.until } : {}),
        })
    if (!result.ok) {
      this.#clearUnavailableBinding(result.error.code)
      return result
    }
    if (result.state.conversationId !== this.#conversationId) {
      this.#setBinding(null)
      return sessionNotFound()
    }
    this.#setBinding(result.state.sessionId)
    return result
  }

  observe(input: BrowserCapabilityObserveInput = {}): Promise<BrowserObserveResult> {
    const captured = { ...input }
    return this.#track(() => this.#observe(captured))
  }

  async #observe(input: BrowserCapabilityObserveInput): Promise<BrowserObserveResult> {
    this.#setPolicy(null)
    const state = await this.#getState()
    if (!state.ok)
      return state
    const request: BrowserObserveParams = {
      pageId: state.state.pageId,
      sessionId: state.state.sessionId,
      ...(input.maxElements === undefined ? {} : { maxElements: input.maxElements }),
    }
    const result = await this.#host.observe(request)
    if (!result.ok) {
      this.#clearUnavailableBinding(result.error.code)
      return result
    }
    if (result.observation.sessionId !== state.state.sessionId) {
      this.#setBinding(null)
      return sessionNotFound()
    }
    if (result.observation.pageId !== state.state.pageId)
      return targetStale()
    this.#setPolicy(createPolicyObservation(result.observation))
    return result
  }

  classifyAction(
    input: BrowserCapabilityActInput,
  ): BrowserCapabilityActionClassificationResult {
    const observation = this.#policyObservation
    if (
      !observation
      || observation.pageId !== input.pageId
      || observation.observationId !== input.observationId
      || observation.documentRevision !== input.documentRevision
    ) {
      return staleClassification()
    }
    const ref = getBrowserActionRef(input.action)
    const target = ref ? observation.elements.get(ref) ?? null : null
    if (ref && (!target || target.frameId !== input.frameId))
      return staleClassification()
    const classification = classifyBrowserAction({
      action: input.action,
      observationContainsHumanInput: observation.observationContainsHumanInput,
      target,
    })
    if (
      target
      && classification.risk !== 'sensitive-input'
      && !supportsObservedAction(target, input.action)
    ) {
      return staleClassification()
    }
    if (
      classification.risk === 'commit-like'
      || classification.risk === 'unknown-commit-like'
    ) {
      return {
        ...classification,
        approvalReview: createBrowserApprovalReview(
          input,
          observation,
          target,
          classification,
        ),
      }
    }
    return classification
  }

  validateActionApproval(input: BrowserCapabilityActInput, expectedReview: BrowserApprovalReviewInput): Promise<BrowserActionApprovalValidationResult> {
    const captured = structuredClone(input)
    const review = structuredClone(expectedReview)
    return this.#track(() => this.#validateActionApproval(captured, review))
  }

  async #validateActionApproval(input: BrowserCapabilityActInput, expectedReview: BrowserApprovalReviewInput): Promise<BrowserActionApprovalValidationResult> {
    const classification = this.classifyAction(input)
    if (
      'blocked' in classification
      || !classification.approvalReview
      || classification.approvalReview.actionDigest !== expectedReview.actionDigest
      || classification.approvalReview.sessionId !== expectedReview.sessionId
      || classification.approvalReview.pageId !== expectedReview.pageId
      || classification.approvalReview.documentRevision !== expectedReview.documentRevision
    ) {
      this.#setPolicy(null)
      return staleApprovalValidation()
    }
    const sessionId = this.#sessionId
    if (!sessionId || sessionId !== expectedReview.sessionId) {
      this.#setPolicy(null)
      return staleApprovalValidation()
    }
    const result = await this.#host.validateAction({ ...input, sessionId })
    if (!result.ok) {
      this.#setPolicy(null)
      this.#clearUnavailableBinding(result.error.code)
      return { blocked: true, reason: result.error.code }
    }
    return null
  }

  act(input: BrowserCapabilityActInput, parent = new AbortController().signal): Promise<BrowserActResult> {
    const captured = structuredClone(input)
    const signal = AbortSignal.any([parent, this.#shutdown.signal])
    const operationId = randomUUID()
    return this.#track(async () => {
      try {
        return await this.#act(captured, signal, operationId)
      }
      finally { this.#publish({ kind: 'action', operationId, phase: 'caller-settled', cancelled: signal.aborted }) }
    })
  }

  async #act(input: BrowserCapabilityActInput, signal: AbortSignal, operationId: string): Promise<BrowserActResult> {
    signal.throwIfAborted()
    const state = await this.#getState()
    if (!state.ok)
      return state
    if (state.state.pageId !== input.pageId)
      return targetStale()

    const acquired = await this.#host.acquireControl({
      pageId: input.pageId,
      sessionId: state.state.sessionId,
    })
    if (!acquired.ok) {
      this.#clearUnavailableBinding(acquired.error.code)
      return acquired
    }
    const { lease } = acquired
    this.#publish({ kind: 'control', operationId, phase: 'acquired', controlEpoch: lease.controlEpoch, cancelled: signal.aborted })
    const releaseInput: BrowserReleaseControlParams = {
      controlEpoch: lease.controlEpoch,
      pageId: lease.pageId,
      sessionId: lease.sessionId,
    }
    if (lease.sessionId !== state.state.sessionId) {
      await this.#releaseControl(releaseInput, operationId, signal)
      this.#setBinding(null)
      return sessionNotFound()
    }
    if (lease.pageId !== input.pageId) {
      await this.#releaseControl(releaseInput, operationId, signal)
      return targetStale()
    }

    let releasePromise: Promise<void> | null = null
    const release = () => {
      releasePromise ??= this.#releaseControl(releaseInput, operationId, signal)
      return releasePromise
    }
    const onAbort = () => void release()
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      signal.throwIfAborted()
      this.#setPolicy(null)
      this.#publish({ kind: 'action', operationId, phase: 'dispatched', cancelled: signal.aborted })
      const response = this.#track(async () => {
        try {
          const result = await this.#host.act({ ...input, controlEpoch: lease.controlEpoch, sessionId: lease.sessionId })
          this.#publish({ kind: 'action', operationId, phase: 'response-received', accepted: result.ok, cancelled: signal.aborted })
          return result
        }
        catch (error) {
          this.#publish({ kind: 'action', operationId, phase: 'response-unknown', cancelled: signal.aborted })
          throw error
        }
      })
      const result = await waitForAbort(response, signal)
      if (!result.ok) {
        this.#clearUnavailableBinding(result.error.code)
        return result
      }
      if (
        result.state.conversationId !== this.#conversationId
        || result.state.sessionId !== lease.sessionId
        || result.observation.sessionId !== lease.sessionId
      ) {
        this.#setBinding(null)
        return sessionNotFound()
      }
      if (
        result.state.pageId !== lease.pageId
        || result.observation.pageId !== result.state.pageId
      ) {
        return targetStale()
      }
      this.#setPolicy(createPolicyObservation(result.observation))
      return result
    }
    finally {
      signal.removeEventListener('abort', onAbort)
      await release()
    }
  }

  getState(): Promise<BrowserStateResult> { return this.#track(() => this.#getState()) }

  async #getState(): Promise<BrowserStateResult> {
    const sessionId = this.#sessionId
    if (!sessionId)
      return sessionNotFound()
    const result = await this.#host.getState(sessionId)
    if (!result.ok) {
      this.#clearUnavailableBinding(result.error.code)
      return result
    }
    if (
      result.state.conversationId !== this.#conversationId
      || result.state.sessionId !== sessionId
    ) {
      this.#setBinding(null)
      return sessionNotFound()
    }
    return result
  }

  close(): Promise<BrowserCloseResult> { return this.#track(() => this.#close()) }

  async #close(): Promise<BrowserCloseResult> {
    const sessionId = this.#sessionId
    if (!sessionId)
      return sessionNotFound()
    const result = await this.#host.close(sessionId)
    if (result.ok || isUnavailable(result.error.code)) {
      this.#setBinding(null)
      this.#setPolicy(null)
    }
    return result
  }

  #clearUnavailableBinding(code: BrowserErrorCode): void {
    if (isUnavailable(code)) {
      this.#setBinding(null)
      this.#setPolicy(null)
    }
  }

  async #releaseControl(input: BrowserReleaseControlParams, operationId: string, signal: AbortSignal): Promise<void> {
    try {
      const result = await this.#host.releaseControl(input)
      this.#publish({ kind: 'control', operationId, phase: result.ok ? 'released' : 'release-unknown', controlEpoch: input.controlEpoch, cancelled: signal.aborted })
      if (!result.ok)
        this.#clearUnavailableBinding(result.error.code)
    }
    catch { this.#publish({ kind: 'control', operationId, phase: 'release-unknown', controlEpoch: input.controlEpoch, cancelled: signal.aborted }) }
  }

  dispose(): Promise<void> {
    this.#disposing ??= Promise.resolve().then(async () => {
      await Promise.allSettled([...this.#pending])
      this.#setPolicy(null)
      this.#setBinding(null)
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

  #binding() {
    return { sessionId: this.#sessionId, pageId: this.#policyObservation?.pageId ?? null, observationId: this.#policyObservation?.observationId ?? null, documentRevision: this.#policyObservation?.documentRevision ?? null, count: this.#policyObservation?.elements.size ?? 0 }
  }

  #setBinding(sessionId: string | null): void {
    if (this.#sessionId === sessionId)
      return
    this.#sessionId = sessionId
    this.#changes.fire(copyEventSnapshot({ kind: 'binding', revision: ++this.#revision, ...this.#binding() }))
  }

  #setPolicy(observation: BrowserPolicyObservation | null): void {
    if (this.#policyObservation === observation)
      return
    this.#policyObservation = observation
    this.#changes.fire(copyEventSnapshot({ kind: 'policy', revision: ++this.#revision, ...this.#binding() }))
  }

  #publish(change: Omit<Extract<BrowserCapabilityChange, { kind: 'action' | 'control' }>, 'revision'>): void {
    this.#changes.fire(copyEventSnapshot({ ...change, revision: ++this.#revision }))
  }
}

function cloneGrant(grant: DirectoryGrant): DirectoryGrant {
  return { ...grant }
}

function isUnavailable(code: BrowserErrorCode): boolean {
  return code === 'BROWSER_SESSION_EVICTED'
    || code === 'BROWSER_SESSION_NOT_FOUND'
}

function sessionNotFound(): BrowserFailure {
  return {
    error: {
      code: 'BROWSER_SESSION_NOT_FOUND',
      reason: null,
      recovery: 'open_again',
    },
    ok: false,
  }
}

function targetStale(): BrowserFailure {
  return {
    error: {
      code: 'BROWSER_TARGET_STALE',
      reason: null,
      recovery: 'read_again',
    },
    ok: false,
  }
}

function staleClassification(): BrowserCapabilityActionClassificationResult {
  return { blocked: true, reason: 'BROWSER_TARGET_STALE' }
}

function createPolicyObservation(
  observation: BrowserObservation,
): BrowserPolicyObservation {
  const captured = copyEventSnapshot(observation)
  const elements = new Map(captured.elements.map(element => [
    element.ref,
    {
      ...element,
      actions: [...element.actions],
      states: [...element.states],
    },
  ]))
  return {
    documentRevision: captured.documentRevision,
    elements,
    observationContainsHumanInput: captured.elements.some(
      element => element.inputMode === 'human',
    ),
    observationId: captured.observationId,
    pageId: captured.pageId,
    sessionId: captured.sessionId,
    url: captured.url,
  }
}

function createBrowserApprovalReview(
  input: BrowserCapabilityActInput,
  observation: BrowserPolicyObservation,
  target: BrowserObservedElement | null,
  classification: Extract<
    BrowserActionClassification,
    { risk: 'commit-like' | 'unknown-commit-like' }
  >,
): BrowserApprovalReviewInput {
  const review = {
    action: input.action.kind as 'click' | 'press',
    documentRevision: observation.documentRevision,
    effect: classification.risk === 'commit-like'
      ? classification.effect
      : null,
    key: input.action.kind === 'press'
      && (input.action.key === 'Enter' || input.action.key === 'Space')
      ? input.action.key
      : null,
    observationId: observation.observationId,
    origin: observation.url === 'about:blank'
      ? observation.url
      : new URL(observation.url).origin,
    pageId: observation.pageId,
    risk: classification.risk,
    sessionId: observation.sessionId,
    targetName: target?.name || null,
    targetRole: target?.role ?? null,
  }
  return {
    ...review,
    actionDigest: createBrowserActionDigest(input, review),
  }
}

function createBrowserActionDigest(
  input: BrowserCapabilityActInput,
  review: Omit<BrowserApprovalReviewInput, 'actionDigest'>,
): string {
  const action = input.action.kind === 'click'
    ? { kind: input.action.kind, ref: input.action.ref }
    : input.action.kind === 'press'
      ? { key: input.action.key, kind: input.action.kind, ref: input.action.ref ?? null }
      : { kind: input.action.kind }
  return createHash('sha256').update(JSON.stringify({
    action,
    documentRevision: review.documentRevision,
    effect: review.effect,
    frameId: input.frameId ?? null,
    observationId: review.observationId,
    origin: review.origin,
    pageId: review.pageId,
    risk: review.risk,
    sessionId: review.sessionId,
    targetName: review.targetName,
    targetRole: review.targetRole,
    version: 1,
  })).digest('hex')
}

function staleApprovalValidation(): BrowserActionApprovalValidationResult {
  return { blocked: true, reason: 'BROWSER_TARGET_STALE' }
}

function supportsObservedAction(
  target: BrowserObservedElement,
  action: BrowserCapabilityActInput['action'],
): boolean {
  switch (action.kind) {
    case 'click':
    case 'fill':
    case 'select':
    case 'type':
      return target.actions.includes(action.kind)
    case 'press':
      return target.actions.length > 0
    case 'scroll':
    case 'wait':
      return true
    default:
      return false
  }
}

function waitForAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new DOMException(
      'This operation was aborted',
      'AbortError',
    ))
    signal.addEventListener('abort', onAbort, { once: true })
    void promise.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort)
    })
  })
}
