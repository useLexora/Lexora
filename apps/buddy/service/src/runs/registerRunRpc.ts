import type { RunEventReader } from '../events/RunEventPorts'
import type { RuntimeRequestRegistrar } from '../rpc/runtimeRequest'
import type { RunInputRepository } from '../storage/runInputRepository'
import type { RunRecord } from '../storage/runRecord'
import type { RunRepository } from '../storage/runRepository'
import type { UsageRepository } from '../storage/usageRepository'
import { runsStatusRpc } from '../../../shared/runs/conversationStatusApi'
import { toPublicRunEvent } from '../../../shared/runs/publicRunEvent'
import { runsRpc } from '../../../shared/runs/runApi'
import { BuddyServiceError, registerRuntimeRequest } from '../rpc/runtimeRequest'
import { ConversationStatusService } from './ConversationStatusService'
import { toPublicRun } from './publicRun'

export interface RegisterRunRpcOptions {
  eventLog: Pick<RunEventReader, 'list' | 'listForConversation'>
  inputs: Pick<RunInputRepository, 'findByRunId'>
  repository: Pick<
    RunRepository,
    'findById' | 'listForConversation' | 'listRecent'
  >
  usage: Pick<UsageRepository, 'listForRun'>
  rpc: RuntimeRequestRegistrar
}

export function registerRunRpc(options: RegisterRunRpcOptions): () => void {
  const publicRun = (run: RunRecord) => toPublicRun(
    run,
    options.inputs.findByRunId(run.id)?.reasoning ?? null,
  )
  const status = new ConversationStatusService({
    events: options.eventLog,
    repository: options.repository,
    usage: options.usage,
  })
  const disposers = [
    registerRuntimeRequest(options.rpc, runsStatusRpc.status, input => status.status(input.conversationId)),
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
      const events = 'conversationId' in input
        ? options.eventLog.listForConversation(input.conversationId, {
            limit: input.limit ?? 500,
          })
        : await options.eventLog.list(input.runId, {
            afterSequence: input.afterSequence,
            limit: input.limit ?? 500,
          })
      return events.map(toPublicRunEvent)
    }),
  ]
  return () => disposers.splice(0).forEach(dispose => dispose())
}
