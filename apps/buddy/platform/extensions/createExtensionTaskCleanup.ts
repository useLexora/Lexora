import type { ConversationCleanup } from '../../shared/conversation/conversationCleanupApi'
import type { ExtensionTaskCleanup } from '../../shared/extensions/extensionTaskCleanup'
import { extensionTaskCleanupDeleteSchema, extensionTaskCleanupItemSchema, extensionTaskCleanupListSchema, extensionTaskCleanupPageSchema, extensionTaskCleanupResultSchema } from '../../shared/extensions/extensionTaskCleanup'

export function createExtensionTaskCleanup(cleanup: ConversationCleanup): ExtensionTaskCleanup {
  return {
    list: async (input) => {
      const { cursor, limit } = extensionTaskCleanupListSchema.parse(input)
      const page = await cleanup.list({ scope: 'legacy_removed', cursor, limit })
      return extensionTaskCleanupPageSchema.parse({
        items: page.items.map(item => extensionTaskCleanupItemSchema.strip().parse(item)),
        nextCursor: page.nextCursor,
      })
    },
    delete: async (input) => {
      const { conversationId, expectedRevision } = extensionTaskCleanupDeleteSchema.parse(input)
      return extensionTaskCleanupResultSchema.strip().parse(await cleanup.delete({ scope: 'legacy_removed', conversationId, expectedRevision }))
    },
  }
}
