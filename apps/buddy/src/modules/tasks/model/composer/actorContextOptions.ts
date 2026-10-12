import type { LocalBuddy } from '@buddy-shared/buddies/buddyApi'
import type { ChatPromptContextOption } from '@/modules/prompt-input'

export function createActorContextOptions(buddies: readonly LocalBuddy[], query: string): ChatPromptContextOption[] {
  const search = query.trim().toLowerCase()
  return buddies
    .filter(buddy => buddy.kind === 'actor' && buddy.enabled && !buddy.deletedAt && buddy.name.toLowerCase().includes(search))
    .map(buddy => ({
      actorReference: { type: 'actor_ref', actorId: buddy.id, name: buddy.name },
      avatar: buddy.avatar,
      category: 'actors',
      description: null,
      kind: 'actorReference',
      label: buddy.name,
      path: null,
      value: buddy.id,
    }))
}
