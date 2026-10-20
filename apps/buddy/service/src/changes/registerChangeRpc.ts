import type { RuntimeRequestRegistrar } from '../rpc/runtimeRequest'
import type { ConversationRepository } from '../storage/conversationRepository'
import type { RunRepository } from '../storage/runRepository'
import type { ChangeCaptureService } from './ChangeCaptureService'
import type { MutationRecoveryService } from './MutationRecoveryService'
import { changesRecoveryRpc, changesRpc } from '../../../shared/changes/changeApi'
import { BuddyServiceError, registerRuntimeRequest } from '../rpc/runtimeRequest'
import { ChangeCaptureError } from './ChangeCaptureService'

export function registerChangeRpc(options: {
  rpc: RuntimeRequestRegistrar
  recovery: MutationRecoveryService
  service: Pick<ChangeCaptureService, 'getVisibleDetail' | 'getForRuns'>
  conversations: Pick<ConversationRepository, 'findById' | 'listBranchMessages'>
  runs: Pick<RunRepository, 'listForTimeline' | 'listTree'>
}): () => void {
  const get = registerRuntimeRequest(options.rpc, changesRpc.get, async (input) => {
    try {
      return await options.service.getVisibleDetail(input.changeSetId)
    }
    catch (error) {
      if (error instanceof ChangeCaptureError)
        throw new BuddyServiceError('VALIDATION_FAILED')
      throw error
    }
  })
  const overview = registerRuntimeRequest(options.rpc, changesRpc.overview, async (input) => {
    const conversation = options.conversations.findById(input.conversationId)
    if (!conversation || conversation.deletedAt)
      throw new BuddyServiceError('VALIDATION_FAILED')
    const messages = options.conversations.listBranchMessages(input.conversationId, input.branchId)
    const runs = options.runs.listForTimeline(
      input.conversationId,
      input.branchId,
      messages.filter(message => message.role === 'user').map(message => message.id),
      messages.flatMap(message => message.runId ? [message.runId] : []),
    )
    const result = await options.service.getForRuns([...new Set(runs.flatMap(run => options.runs.listTree(run.id).map(member => member.id)))])
    if (options.conversations.findById(input.conversationId)?.deletedAt !== null)
      throw new BuddyServiceError('VALIDATION_FAILED')
    return result
  })
  const listRecovery = registerRuntimeRequest(options.rpc, changesRecoveryRpc.list, input => options.recovery.list(input))
  const recheckRecovery = registerRuntimeRequest(options.rpc, changesRecoveryRpc.recheck, (input, signal) => options.recovery.recheckVisible(input, signal))
  const resolveRecovery = registerRuntimeRequest(options.rpc, changesRecoveryRpc.resolve, (input, signal) => options.recovery.resolve(input, signal))
  return () => {
    get()
    overview()
    listRecovery()
    recheckRecovery()
    resolveRecovery()
  }
}
