import type { BuddyRuntime } from '../BuddyRuntime'
import type { RuntimeRequestRegistrar } from '../rpc/runtimeRequest'
import type { ChatCommandService } from './ChatCommandService'
import type { ChatQueueService } from './ChatQueueService'
import type { ChatTurnService } from './ChatTurnService'
import type { ComposerDraftService } from './ComposerDraftService'
import { chatRpc } from '../../../shared/conversation/chatApi'
import { chatQueueRpc } from '../../../shared/conversation/chatQueueApi'

import { registerRuntimeRequest } from '../rpc/runtimeRequest'

export interface RegisterChatRpcOptions {
  drafts: Pick<ComposerDraftService, 'run'>
  queue: ChatQueueService
  commands: Pick<ChatCommandService, 'execute'>
  rpc: RuntimeRequestRegistrar
  runtime: BuddyRuntime
  turns: Pick<
    ChatTurnService,
    'cancel' | 'editUserMessage' | 'regenerateAssistant'
  >
}

export function registerChatRpc(options: RegisterChatRpcOptions): () => void {
  const disposers = [
    registerRuntimeRequest(options.rpc, chatQueueRpc.enqueue, params => options.drafts.run(params.draftId, () => options.queue.enqueue(params))),
    registerRuntimeRequest(options.rpc, chatQueueRpc.list, params => options.queue.list(params)),
    registerRuntimeRequest(options.rpc, chatQueueRpc.cancel, params => options.queue.cancel(params)),
    registerRuntimeRequest(options.rpc, chatQueueRpc.steer, params => options.queue.steer(params)),
    registerRuntimeRequest(options.rpc, chatRpc.executeCommand, params => (
      options.drafts.run(params.draftId, () => options.commands.execute(params))
    )),
    registerRuntimeRequest(options.rpc, chatRpc.startTurn, params => (
      options.drafts.run(params.draftId, () => options.runtime.startTurn(params))
    )),
    registerRuntimeRequest(options.rpc, chatRpc.editUserMessage, params => (
      options.turns.editUserMessage(params)
    )),
    registerRuntimeRequest(options.rpc, chatRpc.regenerateAssistant, params => (
      options.turns.regenerateAssistant(params)
    )),
    registerRuntimeRequest(options.rpc, chatRpc.cancel, (input) => {
      return options.turns.cancel(input.runId)
    }),
  ]
  return () => disposers.splice(0).forEach(dispose => dispose())
}
