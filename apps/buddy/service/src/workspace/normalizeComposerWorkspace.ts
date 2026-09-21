import type { ComposerResourceService } from '../attachments/ComposerResourceService'
import type { ConversationRepository } from '../storage/conversationRepository'
import { getBuddyChatCommandDefinition, isRetiredBuddyPromptCommand, parseBuddyChatCommand } from '../../../shared/conversation/buddyChatCommands'
import { BuddyServiceError } from '../rpc/runtimeRequest'

export async function normalizeComposerWorkspace(value: unknown, options: {
  conversations: Pick<ConversationRepository, 'findById'>
  resources: Pick<ComposerResourceService, 'selectSpaceFilePath'>
}): Promise<unknown> {
  if (!isRecord(value) || !Array.isArray(value.drafts))
    return value
  const drafts = []
  for (const draft of value.drafts) {
    if (!isRecord(draft) || typeof draft.draftId !== 'string' || typeof draft.targetKey !== 'string')
      throw new BuddyServiceError('VALIDATION_FAILED')
    const draftId = draft.draftId
    const spaceId = draft.targetKey.startsWith('space:')
      ? draft.targetKey.slice(6)
      : draft.targetKey.startsWith('conversation:') ? options.conversations.findById(draft.targetKey.slice(13))?.spaceId ?? null : null
    drafts.push({ ...draft, composerContent: await normalize(draft.composerContent) })

    async function normalize(node: unknown): Promise<unknown> {
      if (!isRecord(node))
        return node
      if (node.type === 'chatPromptToken') {
        if (!isRecord(node.attrs) || typeof node.attrs.value !== 'string' || !node.attrs.value)
          throw new BuddyServiceError('VALIDATION_FAILED')
        const attrs = node.attrs
        const value = attrs.value as string
        if (attrs.kind === 'file') {
          if (!spaceId)
            throw new BuddyServiceError('DIRECTORY_NOT_AUTHORIZED')
          const resource = await options.resources.selectSpaceFilePath(draftId, spaceId, value)
          return { type: 'chatResourceReference', attrs: { resourceId: resource.resourceId } }
        }
        if (attrs.kind === 'skill')
          return { type: 'chatPromptDirective', attrs: { directive: 'skill', value } }
        if (attrs.kind !== 'slashCommand')
          throw new BuddyServiceError('VALIDATION_FAILED')
        if (isRetiredBuddyPromptCommand(value))
          return { text: value, type: 'text' }
        const command = parseBuddyChatCommand(value)
        if (!command || command.arguments)
          throw new BuddyServiceError('VALIDATION_FAILED')
        return { type: 'chatPromptDirective', attrs: { directive: 'slash_command', commandMode: getBuddyChatCommandDefinition(command.name).kind, value } }
      }
      return Array.isArray(node.content) ? { ...node, content: await Promise.all(node.content.map(normalize)) } : node
    }
  }
  return { ...value, drafts }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
