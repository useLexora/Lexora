import type { ChangeRecoveryListRequest, ChangeRecoveryRecheckRequest, ChangeRecoveryResolveRequest, LocalChangeRecoveryItem } from '../../../shared/changes/changeApi'
import type { ApplicationDiagnosticReporter } from '../../../shared/diagnostics/applicationDiagnostic'
import type { ConversationRepository } from '../storage/conversationRepository'
import type { RunRepository } from '../storage/runRepository'
import type { MutationCoordinator, MutationHazard } from './MutationCoordinator'
import type { MutationEvidenceRepository } from './mutationEvidenceRepository'
import { createHash } from 'node:crypto'
import process from 'node:process'
import { z } from 'zod'
import { captureProcessRecoveryCheckpoint, reverifyOwnedProcess, supervisedProcessIdentitySchema } from '../../../platform/process/ownedProcessRecovery'
import { safeDiagnosticReporter } from '../../../shared/diagnostics/applicationDiagnostic'
import { BuddyServiceError } from '../rpc/runtimeRequest'

const identitySchema = z.object({
  kind: z.string(),
  nonce: z.string().optional(),
  requestId: z.string().optional(),
}).passthrough()

type ProcessIdentity = z.infer<typeof identitySchema>

export interface MutationRecoveryOptions {
  mutations: MutationCoordinator
  verify?: typeof reverifyOwnedProcess
  checkpoint?: typeof captureProcessRecoveryCheckpoint
  record?: ApplicationDiagnosticReporter
  evidence?: MutationEvidenceRepository
  receiptDirectory?: string
  context?: {
    conversations: Pick<ConversationRepository, 'findById'>
    runs: Pick<RunRepository, 'findById' | 'listIdsForConversation'>
  }
  onChange?: (runId: string) => void
}

export class MutationRecoveryService {
  readonly #options: MutationRecoveryOptions
  readonly #record: ApplicationDiagnosticReporter
  #tail: Promise<unknown> = Promise.resolve()

  constructor(options: MutationRecoveryOptions) {
    this.#options = options
    this.#record = safeDiagnosticReporter(options.record)
  }

  recheck(input: { signal?: AbortSignal, invocationIds?: readonly string[] } = {}): Promise<void> {
    const signal = input.signal ?? AbortSignal.timeout(15_000)
    return this.#serialize(async () => {
      for (const hazard of this.#options.mutations.getHazards()) {
        if (signal.aborted)
          break
        if (input.invocationIds && !input.invocationIds.includes(hazard.invocationId))
          continue
        try {
          await this.#recheck(hazard, signal)
        }
        catch {
          if (signal.aborted)
            break
          this.#observe(hazard, 'unknown', 'RECOVERY_VERIFICATION_FAILED')
        }
      }
    })
  }

  list(input: ChangeRecoveryListRequest): LocalChangeRecoveryItem[] {
    const context = this.#options.context
    const conversation = context?.conversations.findById(input.conversationId)
    if (!context || !conversation || conversation.deletedAt)
      throw new BuddyServiceError('VALIDATION_FAILED')
    const runIds = new Set(context.runs.listIdsForConversation(input.conversationId))
    return this.#options.mutations.getHazards().flatMap((hazard) => {
      if (!runIds.has(hazard.runId) && !this.#options.evidence?.blockedRuns(hazard.invocationId).some(runId => runIds.has(runId)))
        return []
      const run = context.runs.findById(hazard.runId)
      const owner = run ? context.conversations.findById(run.conversationId) : null
      const latest = this.#options.evidence?.latest(hazard.invocationId)
      const status = latest?.outcome === 'active' ? 'active' as const : 'unknown' as const
      const reason = latest?.reason ?? hazard.reason
      const processes = [...this.#options.mutations.getOwnedProcesses(hazard.invocationId)].sort((a, b) => a.processId.localeCompare(b.processId))
      return [{
        invocationId: hazard.invocationId,
        runId: hazard.runId,
        conversationId: owner && !owner.deletedAt ? owner.id : null,
        taskTitle: owner && !owner.deletedAt ? owner.title ?? '' : '',
        occurredAt: this.#options.evidence?.createdAt(hazard.invocationId) ?? run?.startedAt ?? new Date().toISOString(),
        affectedResources: hazard.claims.map(claim => claim.kind === 'host' ? 'host' : claim.canonicalPath),
        reason,
        status,
        revision: createHash('sha256').update(JSON.stringify({ hazard, processes, status, reason })).digest('hex'),
      }]
    })
  }

  async recheckVisible(input: ChangeRecoveryRecheckRequest, signal?: AbortSignal): Promise<LocalChangeRecoveryItem[]> {
    const visible = new Set(this.list(input).map(item => item.invocationId))
    if (input.invocationIds.some(id => !visible.has(id)))
      throw new BuddyServiceError('VALIDATION_FAILED')
    await this.recheck({ signal, invocationIds: input.invocationIds })
    return this.list(input)
  }

  resolve(input: ChangeRecoveryResolveRequest, signal?: AbortSignal): Promise<LocalChangeRecoveryItem[]> {
    return this.#serialize(async () => {
      signal?.throwIfAborted()
      const visible = new Map(this.list(input).map(item => [item.invocationId, item]))
      if (input.items.some((item) => {
        const current = visible.get(item.invocationId)
        return !current || current.status !== 'unknown' || current.revision !== item.revision
      })) {
        throw new BuddyServiceError('VALIDATION_FAILED')
      }
      if (!this.#options.evidence)
        throw new BuddyServiceError('RUNTIME_UNAVAILABLE')
      for (const item of input.items) {
        signal?.throwIfAborted()
        const current = this.list(input).find(candidate => candidate.invocationId === item.invocationId)
        if (!current || current.status !== 'unknown' || current.revision !== item.revision)
          throw new BuddyServiceError('VALIDATION_FAILED')
        await this.#options.mutations.waiveHazard(item.invocationId)
        this.#options.onChange?.(visible.get(item.invocationId)!.runId)
      }
      return this.list(input)
    })
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.catch(() => {}).then(operation)
    this.#tail = result
    return result
  }

  #observe(hazard: MutationHazard, outcome: 'active' | 'unknown', reason: string): void {
    this.#options.evidence?.append({ invocationId: hazard.invocationId, kind: 'observed', outcome, reason, actor: 'system' })
    this.#record({ event: outcome === 'active' ? 'mutation.recovery.active' : 'mutation.recovery.protected', level: 'warn', runId: hazard.runId, operationId: hazard.invocationId, errorCode: reason })
    this.#options.onChange?.(hazard.runId)
  }

  async #recheck(hazard: MutationHazard, signal: AbortSignal): Promise<void> {
    const mutations = this.#options.mutations
    if (!mutations.getHazards().some(item => item.invocationId === hazard.invocationId))
      return
    const records = mutations.getOwnedProcesses(hazard.invocationId).map(record => ({ ...record, identity: parseIdentity(record.processId) }))
    const checkpoint = records.find(record => record.identity?.kind === 'recovery-boot')
    const owned = records.filter(record => record.identity?.kind === 'native-shell' || record.identity?.kind === 'sandbox-job')
    const verifiable = records.filter(record => owned.includes(record) || (record.identity?.version === 3 && ['native-shell-dispatch', 'sandbox-dispatch'].includes(record.identity.kind)))
    const released = new Set(records.filter(record => record.settlement === 'released').map(record => record.processId))
    let active = false
    let reason = owned.length ? 'PROCESS_RELEASE_EVIDENCE_MISSING' : records.length ? 'DISPATCH_IDENTITY_MISSING' : 'PROCESS_IDENTITY_MISSING'
    const verify = this.#options.verify ?? reverifyOwnedProcess
    for (const record of verifiable) {
      if (released.has(record.processId))
        continue
      if (signal.aborted)
        return
      const outcome = await verify(record.processId, { signal, checkpoint: checkpoint?.processId, receiptDirectory: this.#options.receiptDirectory })
      if (outcome.status === 'active' || (!active && outcome.status === 'unknown'))
        reason = outcome.reason
      active ||= outcome.status === 'active'
      this.#options.evidence?.append({ invocationId: hazard.invocationId, kind: outcome.status === 'released' ? 'quiesced' : 'observed', outcome: outcome.status === 'released' ? 'applied' : outcome.status, reason: outcome.reason, actor: 'system', processId: record.processId })
      if (outcome.status === 'released')
        released.add(record.processId)
    }
    const sandboxDispatches = records.filter(record => record.identity?.kind === 'sandbox-dispatch')
    const dispatchRecords = [...records.filter(record => record.identity?.kind === 'native-shell-dispatch'), ...sandboxDispatches]
    for (const record of dispatchRecords) {
      if (released.has(record.processId))
        continue
      const identity = record.identity
      if (identity?.kind === 'native-shell-dispatch') {
        const children = owned.filter(child => identity.version === 3
          ? identity.executionId && identity.dispatchId && child.identity?.executionId === identity.executionId && child.identity?.dispatchId === identity.dispatchId
          : identity.nonce && child.identity?.nonce === identity.nonce)
        if (children.length && children.every(child => released.has(child.processId)))
          released.add(record.processId)
      }
      if (identity?.kind === 'sandbox-dispatch' && identity.requestId) {
        const children = records.filter(child => child.identity?.requestId === identity.requestId && child.processId !== record.processId && child.identity?.kind !== 'recovery-boot')
        const legacyChildren = sandboxDispatches.length === 1 && owned.every(child => !child.identity?.requestId) ? owned : []
        const associated = children.length ? children : legacyChildren
        if (associated.length && associated.every(child => released.has(child.processId)))
          released.add(record.processId)
      }
    }
    const withoutCheckpoint = records.filter(record => record.identity?.kind !== 'recovery-boot')
    const complete = withoutCheckpoint.length > 0 && withoutCheckpoint.every(record => released.has(record.processId))
    if (complete || (hazard.reason === 'FILE_RESOURCE_SETTLEMENT_FAILED' && withoutCheckpoint.every(record => released.has(record.processId)))) {
      for (const record of records)
        mutations.recordOwnedProcessSettlement({ invocationId: hazard.invocationId, processId: record.processId, settlement: 'released' })
      try {
        signal.throwIfAborted()
        await waitForVerification(mutations.confirmReleased(hazard.invocationId), signal)
        this.#record({ event: 'mutation.recovery.released', level: 'info', runId: hazard.runId, operationId: hazard.invocationId })
        this.#options.onChange?.(hazard.runId)
      }
      catch {
        signal.throwIfAborted()
        this.#record({ event: 'mutation.recovery.protected', level: 'warn', runId: hazard.runId, operationId: hazard.invocationId, errorCode: 'FILE_RESOURCE_SETTLEMENT_FAILED' })
      }
      return
    }
    for (const record of owned) {
      if (released.has(record.processId))
        mutations.recordOwnedProcessSettlement({ invocationId: hazard.invocationId, processId: record.processId, settlement: 'released' })
    }
    const canCheckpoint = owned.length > 0 && owned.every(record => hasCompleteLocalIdentity(record.identity))
      && withoutCheckpoint.every(record => record.identity && ['native-shell', 'sandbox-job', 'native-shell-dispatch', 'sandbox-dispatch'].includes(record.identity.kind))
    if (!checkpoint && canCheckpoint && !signal.aborted) {
      const baseline = await (this.#options.checkpoint ?? captureProcessRecoveryCheckpoint)({ signal })
      if (baseline) {
        mutations.recordRecoveryCheckpoint(hazard.invocationId, baseline)
        this.#record({ event: 'mutation.recovery.checkpoint_saved', level: 'info', runId: hazard.runId, operationId: hazard.invocationId })
      }
    }
    this.#observe(hazard, active ? 'active' : 'unknown', reason)
  }
}

async function waitForVerification(operation: Promise<void>, signal: AbortSignal): Promise<void> {
  let abort: () => void = () => {}
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted)
      abort()
  })
  try {
    await Promise.race([operation, cancelled])
  }
  finally { signal.removeEventListener('abort', abort) }
}

function hasCompleteLocalIdentity(record: ProcessIdentity | null): boolean {
  if (!record || !record.nonce || record.platform !== process.platform || !['linux', 'win32'].includes(process.platform))
    return false
  const { kind: _kind, platform: _platform, nonce: _nonce, requestId: _requestId, ...identity } = record
  return supervisedProcessIdentitySchema.safeParse(identity).success
}

function parseIdentity(processId: string): ProcessIdentity | null {
  try {
    const parsed = identitySchema.safeParse(JSON.parse(processId))
    return parsed.success ? parsed.data : null
  }
  catch { return null }
}
