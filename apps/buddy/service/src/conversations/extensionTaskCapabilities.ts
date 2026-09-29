import type { ExtensionInvocationScope } from '../plugins/extensionAgentHandlers'
import type { ExtensionTaskContextRepository } from '../storage/extensionTaskContextRepository'
import type { ConversationMetadataService } from './ConversationMetadataService'
import type { ExtensionTaskSession } from './ExtensionTaskContext'
import { extensionAgentHandler } from '../plugins/extensionAgentHandlers'

export function createExtensionTaskCapabilities(conversations: Pick<ConversationMetadataService, 'getTitleState' | 'renameGenerated'>, history: ExtensionTaskContextRepository, task: ExtensionTaskSession, scope: ExtensionInvocationScope) {
  const titleRevision = conversations.getTitleState(scope.conversationId)?.revision
  return {
    'task.get': extensionAgentHandler('task.get', (_input, context) => {
      task.assertCurrent()
      const title = conversations.getTitleState(context.conversationId)
      if (!title)
        throw new Error('EXTENSION_TASK_UNAVAILABLE')
      return { id: context.conversationId, title: title.title, titleSource: title.source }
    }),
    'task.messages': extensionAgentHandler('task.messages', (_input, context) => {
      task.assertCurrent()
      return history.messages(context.conversationId, task.branchId)
    }),
    'task.rename': extensionAgentHandler('task.rename', (input, context) => {
      context.signal.throwIfAborted()
      task.assertCurrent()
      if (titleRevision === undefined)
        return { applied: false }
      const result = conversations.renameGenerated({ id: context.conversationId, title: input.title, expectedRevision: titleRevision, userInitiated: context.action?.cause.type === 'user' })
      return { applied: !!result }
    }),
  }
}
