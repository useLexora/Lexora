import type { RuntimeRequestRegistrar } from '../rpc/runtimeRequest'
import type { ConversationArchiveService } from './ConversationArchiveService'
import { conversationArchiveRpc } from '../../../shared/conversation/conversationArchiveApi'
import { registerRuntimeRequest } from '../rpc/runtimeRequest'

export function registerConversationArchiveRpc(options: {
  rpc: RuntimeRequestRegistrar
  archive: Pick<ConversationArchiveService, 'list' | 'getPolicy' | 'archive' | 'restore' | 'deleteArchived' | 'deletePermanently' | 'setPolicy'>
}): () => void {
  const disposers = [
    registerRuntimeRequest(options.rpc, conversationArchiveRpc.listArchived, input => options.archive.list(input)),
    registerRuntimeRequest(options.rpc, conversationArchiveRpc.getArchivePolicy, () => options.archive.getPolicy()),
    registerRuntimeRequest(options.rpc, conversationArchiveRpc.archive, input => options.archive.archive(input)),
    registerRuntimeRequest(options.rpc, conversationArchiveRpc.restoreArchive, input => options.archive.restore(input)),
    registerRuntimeRequest(options.rpc, conversationArchiveRpc.deleteArchived, input => options.archive.deleteArchived(input)),
    registerRuntimeRequest(options.rpc, conversationArchiveRpc.deletePermanently, input => options.archive.deletePermanently(input)),
    registerRuntimeRequest(options.rpc, conversationArchiveRpc.setArchivePolicy, input => options.archive.setPolicy(input.days)),
  ]
  return () => disposers.splice(0).forEach(dispose => dispose())
}
