import type { BuddyUserContentV1 } from '@buddy-shared/conversation/buddyUserContent'
import { getBuddyUserContentActorReferences } from '@buddy-shared/conversation/buddyUserContent'

export function resolveInputActors(content: BuddyUserContentV1, defaultActorId: string | null) {
  const actors = getBuddyUserContentActorReferences(content)
  const addressedActorId = actors.length === 1 ? actors[0]!.actorId : null
  return { addressedActorId, actorId: addressedActorId ?? defaultActorId, multiple: actors.length > 1 }
}
