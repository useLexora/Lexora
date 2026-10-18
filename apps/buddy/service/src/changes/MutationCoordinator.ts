import type { FileResourceCoordinator } from '../files/FileResourceCoordinator'
import type { MutationRepository, OwnedProcessSettlement } from './mutationRepository'
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { containsCanonicalPath, filePaths } from '../../../platform/filesystem/filePaths'
import { Emitter } from '../../../shared/events/Emitter'
import { copyEventSnapshot } from '../../../shared/events/eventSnapshot'

export type MutationClaim
  = { kind: 'file' | 'tree', canonicalPath: string }
    | { kind: 'host' }

export type MutationLifetime = 'runtime' | 'external'

export interface MutationIdentity {
  runId: string
  invocationId: string
}

export interface MutationHazard extends MutationIdentity {
  claims: readonly MutationClaim[]
  reason: string
}

export interface MutationRunState {
  pending: number
  active: number
  hazards: readonly MutationHazard[]
}

export interface MutationLease extends MutationIdentity {
  segmentId: string
  lifetime: MutationLifetime
  sequence: number
  claims: readonly MutationClaim[]
  release: () => void
  markHazard: (reason: string) => void
}

interface PendingMutation extends MutationIdentity {
  claims: readonly MutationClaim[]
  lifetime: MutationLifetime
  signal: AbortSignal
  resolve: (lease: MutationLease) => void
  reject: (error: unknown) => void
  unsubscribe: () => void
}

export class MutationCoordinatorError extends Error {
  readonly code: 'MUTATION_RESOURCE_UNSAFE' | 'MUTATION_COORDINATOR_STOPPED' | 'MUTATION_INVOCATION_CONFLICT'

  constructor(code: MutationCoordinatorError['code']) {
    super(code === 'MUTATION_RESOURCE_UNSAFE' ? `${code}: An earlier operation has an unverified outcome. Conflicting writes remain blocked. Check application logs for details.` : code)
    this.code = code
    this.name = 'MutationCoordinatorError'
  }
}

export class MutationCoordinator {
  readonly #active = new Map<string, MutationLease>()
  readonly #closing = new Set<string>()
  readonly #hazards = new Map<string, MutationHazard>()
  readonly #pending: PendingMutation[] = []
  readonly #invocation = new AsyncLocalStorage<MutationLease>()
  readonly #processes = new Map<string, Map<string, OwnedProcessSettlement>>()
  readonly #resources: Pick<FileResourceCoordinator, 'acquire' | 'release' | 'reconcile'> | undefined
  readonly #settlements = new Map<string, Promise<void>>()
  readonly #repository: MutationRepository | undefined
  readonly #changes = new Emitter<{ runId: string }>(() => console.error('MUTATION_OBSERVER_FAILED'))
  readonly onDidChange = this.#changes.event
  #lastWriter: { runId: string, segmentId: string } | undefined
  #sequence = 0
  #disposed = false

  constructor(options: { repository?: MutationRepository, resources?: Pick<FileResourceCoordinator, 'acquire' | 'release' | 'reconcile'> } = {}) {
    this.#resources = options.resources
    const repository = options.repository
    this.#repository = repository
    if (!repository)
      return
    for (const stored of repository.listUnreleased()) {
      if (stored.processes.length ? stored.processes.every(process => process.settlement === 'released') : stored.lifetime === 'runtime') {
        repository.settle(stored.invocationId, 'released', null)
        continue
      }
      this.#processes.set(stored.invocationId, new Map(stored.processes.map(process => [process.processId, process.settlement])))
      this.restoreHazard({ runId: stored.runId, invocationId: stored.invocationId, claims: stored.claims, reason: stored.reason ?? 'MUTATION_INTERRUPTED' })
    }
  }

  async acquire(input: MutationIdentity & { claims: readonly MutationClaim[], lifetime: MutationLifetime, signal: AbortSignal }): Promise<MutationLease> {
    if (this.#disposed)
      return Promise.reject(new MutationCoordinatorError('MUTATION_COORDINATOR_STOPPED'))
    input.signal.throwIfAborted()
    if (this.#active.has(input.invocationId) || this.#hazards.has(input.invocationId) || this.#pending.some(pending => pending.invocationId === input.invocationId))
      return Promise.reject(new MutationCoordinatorError('MUTATION_INVOCATION_CONFLICT'))
    const claims = normalizeClaims(input.claims)
    const lease = await new Promise<MutationLease>((resolve, reject) => {
      const pending: PendingMutation = {
        runId: input.runId,
        invocationId: input.invocationId,
        claims,
        lifetime: input.lifetime,
        signal: input.signal,
        resolve,
        reject,
        unsubscribe: () => {},
      }
      const cancel = () => {
        const index = this.#pending.indexOf(pending)
        if (index < 0)
          return
        this.#pending.splice(index, 1)
        pending.unsubscribe()
        reject(input.signal.reason)
        this.#publish(input.runId)
        this.#drain()
      }
      pending.unsubscribe = () => input.signal.removeEventListener('abort', cancel)
      input.signal.addEventListener('abort', cancel, { once: true })
      this.#pending.push(pending)
      this.#publish(input.runId)
      this.#drain()
    })
    try {
      await this.#resources?.acquire(lease.invocationId, lease.claims, lease.lifetime, input.signal)
      input.signal.throwIfAborted()
      return lease
    }
    catch (error) {
      lease.release()
      throw error
    }
  }

  async initialize(): Promise<void> {
    await this.#resources?.reconcile([...this.#hazards.values()], id => this.#repository?.isReleased(id) === true)
  }

  getHazards(): readonly MutationHazard[] {
    return copyEventSnapshot([...this.#hazards.values()])
  }

  getOwnedProcesses(invocationId: string): readonly { processId: string, settlement: OwnedProcessSettlement }[] {
    return [...(this.#processes.get(invocationId) ?? [])].map(([processId, settlement]) => ({ processId, settlement }))
  }

  async waitForSettlements(): Promise<void> {
    while (this.#settlements.size)
      await Promise.allSettled(this.#settlements.values())
  }

  getRunState(runId: string): MutationRunState {
    return copyEventSnapshot({
      pending: this.#pending.filter(pending => pending.runId === runId).length,
      active: [...this.#active.values()].filter(lease => lease.runId === runId).length,
      hazards: [...this.#hazards.values()].filter(hazard => hazard.runId === runId),
    })
  }

  withInvocation<T>(lease: MutationLease, operation: () => Promise<T>): Promise<T> {
    return this.#invocation.run(lease, operation)
  }

  getCurrentInvocation(): MutationIdentity | null {
    const lease = this.#invocation.getStore()
    return lease ? Object.freeze({ runId: lease.runId, invocationId: lease.invocationId }) : null
  }

  recordOwnedProcessSettlement(input: { invocationId?: string, processId: string, settlement: 'pending' | 'released' | 'unknown' }): boolean {
    const invocationId = input.invocationId ?? this.#invocation.getStore()?.invocationId
    if (!invocationId || (!this.#active.has(invocationId) && !this.#hazards.has(invocationId)))
      return false
    if (input.settlement === 'pending' && (this.#disposed || this.#closing.has(invocationId) || !this.#active.has(invocationId)))
      return false
    return this.#recordProcess({ ...input, invocationId })
  }

  recordRecoveryCheckpoint(invocationId: string, processId: string): boolean {
    if (this.#disposed || !this.#hazards.has(invocationId))
      return false
    return this.#recordProcess({ invocationId, processId, settlement: 'pending' })
  }

  #recordProcess(input: { invocationId: string, processId: string, settlement: OwnedProcessSettlement }): boolean {
    const { invocationId } = input
    const processes = this.#processes.get(invocationId) ?? new Map<string, 'pending' | 'released' | 'unknown'>()
    if (processes.get(input.processId) === 'released')
      return true
    this.#repository?.recordProcess(invocationId, input.processId, input.settlement)
    processes.set(input.processId, input.settlement)
    this.#processes.set(invocationId, processes)
    if (this.#hazards.has(invocationId) && [...processes.values()].every(value => value === 'released'))
      void this.confirmReleased(invocationId).catch(() => {})
    return true
  }

  getInvocationSettlement(invocationId: string): 'none' | 'released' | 'unknown' {
    const processes = this.#processes.get(invocationId)
    if (!processes?.size)
      return 'none'
    return [...processes.values()].every(value => value === 'released') ? 'released' : 'unknown'
  }

  async waitForRun(runId: string): Promise<MutationRunState> {
    const current = this.getRunState(runId)
    if (!current.pending && !current.active)
      return current
    return new Promise((resolve) => {
      const subscription = this.onDidChange((event) => {
        if (event.runId !== runId)
          return
        const state = this.getRunState(runId)
        if (!state.pending && !state.active) {
          subscription.dispose()
          resolve(state)
        }
      })
    })
  }

  restoreHazard(hazard: MutationHazard): void {
    if (this.#active.has(hazard.invocationId))
      throw new MutationCoordinatorError('MUTATION_INVOCATION_CONFLICT')
    this.#hazards.set(hazard.invocationId, copyEventSnapshot({ ...hazard, claims: normalizeClaims(hazard.claims) }))
    this.#publish(hazard.runId)
    this.#drain()
  }

  async confirmReleased(invocationId: string): Promise<void> {
    const hazard = this.#hazards.get(invocationId)
    if (!hazard)
      return
    if (this.#resources)
      await this.#settleResource(invocationId, false)
    this.#repository?.settle(invocationId, 'released', null)
    this.#hazards.delete(invocationId)
    this.#processes.delete(invocationId)
    this.#publish(hazard.runId)
    this.#drain()
  }

  async dispose(): Promise<void> {
    this.#disposed = true
    for (const pending of this.#pending.splice(0)) {
      pending.unsubscribe()
      pending.reject(new MutationCoordinatorError('MUTATION_COORDINATOR_STOPPED'))
      this.#publish(pending.runId)
    }
    await this.waitForSettlements()
  }

  #drain(): void {
    for (let index = 0; index < this.#pending.length;) {
      const pending = this.#pending[index]!
      if ([...this.#hazards.values()].some(hazard => claimsOverlap(hazard.claims, pending.claims))) {
        this.#pending.splice(index, 1)
        pending.unsubscribe()
        pending.reject(new MutationCoordinatorError('MUTATION_RESOURCE_UNSAFE'))
        this.#publish(pending.runId)
        continue
      }
      if ([...this.#active.values()].some(lease => claimsOverlap(lease.claims, pending.claims))
        || this.#pending.slice(0, index).some(earlier => claimsOverlap(earlier.claims, pending.claims))) {
        index++
        continue
      }
      this.#pending.splice(index, 1)
      pending.unsubscribe()
      const segmentId = this.#lastWriter?.runId === pending.runId ? this.#lastWriter.segmentId : randomUUID()
      this.#lastWriter = { runId: pending.runId, segmentId }
      const lease: MutationLease = {
        runId: pending.runId,
        invocationId: pending.invocationId,
        segmentId,
        sequence: ++this.#sequence,
        claims: pending.claims,
        lifetime: pending.lifetime,
        release: () => this.#release(lease),
        markHazard: reason => this.#release(lease, reason),
      }
      try {
        this.#repository?.createLease(lease)
      }
      catch (error) {
        pending.reject(error)
        this.#publish(pending.runId)
        continue
      }
      this.#active.set(lease.invocationId, lease)
      pending.resolve(lease)
      this.#publish(lease.runId)
    }
  }

  #release(lease: MutationLease, hazard?: string): void {
    if (this.#active.get(lease.invocationId) !== lease || this.#closing.has(lease.invocationId))
      return
    this.#closing.add(lease.invocationId)
    if (hazard === 'OWNED_PROCESS_CLEANUP_UNCONFIRMED' && this.getInvocationSettlement(lease.invocationId) === 'released')
      hazard = undefined
    try {
      this.#repository?.settle(lease.invocationId, hazard ? 'hazard' : 'released', hazard ?? null)
    }
    catch {
      hazard = 'MUTATION_SETTLEMENT_PERSISTENCE_FAILED'
    }
    const finish = (reason?: string) => {
      this.#closing.delete(lease.invocationId)
      this.#active.delete(lease.invocationId)
      if (reason) {
        this.#hazards.set(lease.invocationId, copyEventSnapshot({
          runId: lease.runId,
          invocationId: lease.invocationId,
          claims: lease.claims,
          reason,
        }))
      }
      else {
        this.#processes.delete(lease.invocationId)
      }
      this.#publish(lease.runId)
      this.#drain()
    }
    if (!this.#resources) {
      finish(hazard)
      return
    }
    void this.#settleResource(lease.invocationId, Boolean(hazard)).then(() => finish(hazard), () => {
      const reason = hazard ?? 'FILE_RESOURCE_SETTLEMENT_FAILED'
      try {
        this.#repository?.settle(lease.invocationId, 'hazard', reason)
      }
      catch {}
      finish(reason)
    })
  }

  #settleResource(id: string, hazard: boolean): Promise<void> {
    const previous = this.#settlements.get(id) ?? Promise.resolve()
    const pending = previous.catch(() => {}).then(() => this.#resources?.release(id, hazard)).finally(() => {
      if (this.#settlements.get(id) === pending)
        this.#settlements.delete(id)
    })
    this.#settlements.set(id, pending)
    return pending
  }

  #publish(runId: string): void {
    this.#changes.fire(Object.freeze({ runId }))
  }
}

function normalizeClaims(claims: readonly MutationClaim[]): readonly MutationClaim[] {
  if (claims.some(claim => claim.kind === 'host'))
    return Object.freeze([Object.freeze({ kind: 'host' as const })])
  const result: MutationClaim[] = []
  for (const claim of claims) {
    if (claim.kind === 'host')
      continue
    const canonicalPath = filePaths.resolveInput(claim.canonicalPath)
    if (!result.some(existing => existing.kind !== 'host' && existing.kind === claim.kind && pathKey(existing.canonicalPath) === pathKey(canonicalPath)))
      result.push({ kind: claim.kind, canonicalPath })
  }
  return copyEventSnapshot(result)
}

function claimsOverlap(left: readonly MutationClaim[], right: readonly MutationClaim[]): boolean {
  return left.some(a => right.some((b) => {
    if (a.kind === 'host' || b.kind === 'host')
      return true
    const leftPath = pathKey(a.canonicalPath)
    const rightPath = pathKey(b.canonicalPath)
    return leftPath === rightPath
      || (a.kind === 'tree' && containsCanonicalPath(leftPath, rightPath))
      || (b.kind === 'tree' && containsCanonicalPath(rightPath, leftPath))
  }))
}

function pathKey(path: string): string {
  return filePaths.sensitiveKey(path)
}
