import type { RuntimeRequestRegistrar } from '../rpc/runtimeRequest'
import type { ConversationArchiveService } from './ConversationArchiveService'
import { conversationArchiveRpc } from '../../../shared/conversation/conversationArchiveApi'
import { registerRuntimeRequest } from '../rpc/runtimeRequest'

class ArchiveCommandRequiredError extends Error {
  readonly code = 'METHOD_NOT_AVAILABLE'

  constructor() {
    super('This operation requires the product command protocol')
    this.name = 'ArchiveCommandRequiredError'
  }
}

export function registerConversationArchiveRpc(options: {
  rpc: RuntimeRequestRegistrar
  archive: Pick<ConversationArchiveService, 'list' | 'getPolicy' | 'archive' | 'restore' | 'deleteArchived' | 'setPolicy'>
  legacyWrites?: boolean
}): () => void {
  function assertLegacyWrites(): void {
    if (options.legacyWrites !== true)
      throw new ArchiveCommandRequiredError()
  }
  const disposers = [
    registerRuntimeRequest(options.rpc, conversationArchiveRpc.listArchived, input => options.archive.list(input)),
    registerRuntimeRequest(options.rpc, conversationArchiveRpc.getArchivePolicy, () => options.archive.getPolicy()),
    registerRuntimeRequest(options.rpc, conversationArchiveRpc.archive, (input) => {
      assertLegacyWrites()
      return options.archive.archive(input)
    }),
    registerRuntimeRequest(options.rpc, conversationArchiveRpc.restoreArchive, (input) => {
      assertLegacyWrites()
      return options.archive.restore(input)
    }),
    registerRuntimeRequest(options.rpc, conversationArchiveRpc.deleteArchived, (input) => {
      assertLegacyWrites()
      return options.archive.deleteArchived(input)
    }),
    registerRuntimeRequest(options.rpc, conversationArchiveRpc.setArchivePolicy, (input) => {
      assertLegacyWrites()
      return options.archive.setPolicy(input.days)
    }),
  ]
  return () => disposers.splice(0).forEach(dispose => dispose())
}
