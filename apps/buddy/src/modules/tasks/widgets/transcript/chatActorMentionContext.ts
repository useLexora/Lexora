import type { BuddyActorReference } from '@buddy-shared/conversation/buddyUserContent'
import { createInjectionState } from '@vueuse/core'

interface ChatActorMentionContext {
  canMentionActor: (actorId: string) => boolean
  mentionActor: (reference: BuddyActorReference) => void
}

const [useProvideChatActorMention, injectChatActorMention] = createInjectionState(
  (context: ChatActorMentionContext) => context,
)

export { useProvideChatActorMention }

export function useChatActorMention(): ChatActorMentionContext | null {
  return injectChatActorMention() ?? null
}
