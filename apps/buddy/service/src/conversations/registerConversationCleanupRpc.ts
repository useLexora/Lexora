import type { RuntimeRequestRegistrar } from '../rpc/runtimeRequest'
import type { ConversationCleanupService } from './ConversationCleanupService'
import { conversationCleanupRpc } from '../../../shared/conversation/conversationCleanupApi'
import { registerRuntimeRequest } from '../rpc/runtimeRequest'

export function registerConversationCleanupRpc(options: {
  rpc: RuntimeRequestRegistrar
  cleanup: Pick<ConversationCleanupService, 'list' | 'delete'>
}): () => void {
  const disposers = [
    registerRuntimeRequest(options.rpc, conversationCleanupRpc.list, async input => conversationCleanupRpc.list.response.parse(await options.cleanup.list(input))),
    registerRuntimeRequest(options.rpc, conversationCleanupRpc.delete, async input => conversationCleanupRpc.delete.response.parse(await options.cleanup.delete(input))),
  ]
  return () => disposers.forEach(dispose => dispose())
}
