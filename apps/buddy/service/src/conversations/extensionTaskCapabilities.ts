import type { ConversationMetadataService } from './ConversationMetadataService'
import { extensionAgentHandler } from '../plugins/extensionAgentHandlers'

export function createExtensionTaskCapabilities(conversations: Pick<ConversationMetadataService, 'getTitleState' | 'renameGenerated'>) {
  return {
    'task.get': extensionAgentHandler('task.get', (_input, context) => {
      const title = conversations.getTitleState(context.conversationId)
      if (!title)
        throw new Error('EXTENSION_TASK_UNAVAILABLE')
      return { id: context.conversationId, title: title.title, titleSource: title.source, titleRevision: title.revision }
    }),
    'task.rename': extensionAgentHandler('task.rename', (input, context) => {
      context.signal.throwIfAborted()
      const result = conversations.renameGenerated({ id: context.conversationId, ...input })
      return { applied: !!result }
    }),
  }
}
