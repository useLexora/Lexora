import type { RunEventAvailability, RunEventReader } from '../events/RunEventPorts'
import type { RuntimeRequestRegistrar } from '../rpc/runtimeRequest'
import type { RunInputRepository } from '../storage/runInputRepository'
import type { RunRecord } from '../storage/runRecord'
import type { RunRepository } from '../storage/runRepository'
import type { ConversationStatusService } from './ConversationStatusService'
import { runsStatusRpc } from '../../../shared/runs/conversationStatusApi'
import { toPublicRunEvent } from '../../../shared/runs/publicRunEvent'
import { runsRpc } from '../../../shared/runs/runApi'
import { runsMetricsRpc } from '../../../shared/runs/taskMetricsApi'
import { RunEventCorruptionError } from '../events/RunEventFailure'
import { BuddyServiceError, registerRuntimeRequest } from '../rpc/runtimeRequest'
import { toPublicRun } from './publicRun'

export interface RegisterRunRpcOptions {
  statistics: Pick<ConversationStatusService, 'metrics' | 'status'>
  isBusy: () => boolean
  eventLog: Pick<RunEventReader, 'list' | 'listForConversation' | 'verifyRun'> & Partial<Pick<RunEventAvailability, 'getRecoveryFailures'>>
  inputs: Pick<RunInputRepository, 'findByRunId'>
  repository: Pick<
    RunRepository,
    'findById' | 'listForConversation' | 'listRecent'
  >
  rpc: RuntimeRequestRegistrar
}

export function registerRunRpc(options: RegisterRunRpcOptions): () => void {
  const publicRun = (run: RunRecord) => toPublicRun(
    options.eventLog.getRecoveryFailures?.().some(failure => failure.runId === run.id)
      ? { ...run, errorCode: 'EVENT_LOG_CORRUPTED' }
      : run,
    options.inputs.findByRunId(run.id)?.reasoning ?? null,
  )
  const disposers = [
    registerRuntimeRequest(options.rpc, runsRpc.isBusy, () => options.isBusy()),
    registerRuntimeRequest(options.rpc, runsStatusRpc.status, input => options.statistics.status(input.conversationId, input.branchId)),
    registerRuntimeRequest(options.rpc, runsMetricsRpc.metrics, input => options.statistics.metrics(input)),
    registerRuntimeRequest(options.rpc, runsRpc.list, (input) => {
      const records = input.conversationId
        ? options.repository.listForConversation(input.conversationId, input.limit ?? 100)
        : options.repository.listRecent(input.limit ?? 100)
      return records.map(publicRun)
    }),
    registerRuntimeRequest(options.rpc, runsRpc.get, (input) => {
      const run = options.repository.findById(input.runId)
      if (!run)
        throw new BuddyServiceError('VALIDATION_FAILED')
      return publicRun(run)
    }),
    registerRuntimeRequest(options.rpc, runsRpc.listEvents, async (input) => {
      let events = 'conversationId' in input
        ? options.eventLog.listForConversation(input.conversationId, {
            limit: input.limit ?? 500,
          })
        : await options.eventLog.list(input.runId, {
            afterSequence: input.afterSequence,
            limit: input.limit ?? 500,
          })
      if ('conversationId' in input) {
        const runIds = new Set(events.map(event => event.runId))
        for (const runId of runIds) {
          try {
            await options.eventLog.verifyRun(runId)
          }
          catch (error) {
            if (!(error instanceof RunEventCorruptionError))
              throw error
          }
        }
        events = options.eventLog.listForConversation(input.conversationId, { limit: input.limit ?? 500 }).filter(event => runIds.has(event.runId))
      }
      return events.map(toPublicRunEvent)
    }),
  ]
  return () => disposers.splice(0).forEach(dispose => dispose())
}
