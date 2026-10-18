import type { ApplicationDiagnosticReporter } from '../../../shared/diagnostics/applicationDiagnostic'
import type { MutationCoordinator, MutationHazard } from './MutationCoordinator'
import process from 'node:process'
import { z } from 'zod'
import { captureProcessRecoveryCheckpoint, reverifyOwnedProcess, supervisedProcessIdentitySchema } from '../../../platform/process/ownedProcessRecovery'
import { safeDiagnosticReporter } from '../../../shared/diagnostics/applicationDiagnostic'

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
}

export class MutationRecoveryService {
  readonly #options: MutationRecoveryOptions
  readonly #record: ApplicationDiagnosticReporter

  constructor(options: MutationRecoveryOptions) {
    this.#options = options
    this.#record = safeDiagnosticReporter(options.record)
  }

  async recheck(input: { signal?: AbortSignal } = {}): Promise<void> {
    const signal = input.signal ?? AbortSignal.timeout(15_000)
    for (const hazard of this.#options.mutations.getHazards()) {
      if (signal.aborted)
        break
      try {
        await this.#recheck(hazard, signal)
      }
      catch (error) {
        if (signal.aborted)
          break
        throw error
      }
    }
  }

  async #recheck(hazard: MutationHazard, signal: AbortSignal): Promise<void> {
    const mutations = this.#options.mutations
    if (!mutations.getHazards().some(item => item.invocationId === hazard.invocationId))
      return
    const records = mutations.getOwnedProcesses(hazard.invocationId).map(record => ({ ...record, identity: parseIdentity(record.processId) }))
    const checkpoint = records.find(record => record.identity?.kind === 'recovery-boot')
    const owned = records.filter(record => record.identity?.kind === 'native-shell' || record.identity?.kind === 'sandbox-job')
    const released = new Set(records.filter(record => record.settlement === 'released').map(record => record.processId))
    let active = false
    const verify = this.#options.verify ?? reverifyOwnedProcess
    for (const record of owned) {
      if (released.has(record.processId))
        continue
      if (signal.aborted)
        return
      const outcome = await verify(record.processId, { signal, checkpoint: checkpoint?.processId })
      active ||= outcome.status === 'active'
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
        const children = owned.filter(child => identity.nonce && child.identity?.nonce === identity.nonce)
        if (children.length && children.every(child => released.has(child.processId)))
          released.add(record.processId)
      }
      if (identity?.kind === 'sandbox-dispatch') {
        const children = records.filter(child => child.identity?.requestId === identity.requestId && child.processId !== record.processId && child.identity?.kind !== 'recovery-boot')
        const legacyChildren = sandboxDispatches.length === 1 && owned.every(child => !child.identity?.requestId) ? owned : []
        const associated = children.length ? children : legacyChildren
        if (associated.length && associated.every(child => released.has(child.processId)))
          released.add(record.processId)
      }
    }
    const withoutCheckpoint = records.filter(record => record.identity?.kind !== 'recovery-boot')
    const complete = withoutCheckpoint.length > 0 && withoutCheckpoint.every(record => released.has(record.processId))
    if (complete || hazard.reason === 'FILE_RESOURCE_SETTLEMENT_FAILED') {
      for (const record of records)
        mutations.recordOwnedProcessSettlement({ invocationId: hazard.invocationId, processId: record.processId, settlement: 'released' })
      try {
        signal.throwIfAborted()
        await waitForVerification(mutations.confirmReleased(hazard.invocationId), signal)
        this.#record({ event: 'mutation.recovery.released', level: 'info', runId: hazard.runId, operationId: hazard.invocationId })
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
    this.#record({ event: active ? 'mutation.recovery.active' : 'mutation.recovery.protected', level: 'warn', runId: hazard.runId, operationId: hazard.invocationId, errorCode: 'PROCESS_RELEASE_EVIDENCE_MISSING' })
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
