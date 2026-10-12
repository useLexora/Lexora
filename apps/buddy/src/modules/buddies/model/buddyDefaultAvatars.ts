import npcExecutor from '../assets/avatars/npc-executor.webp'
import npcExplorer from '../assets/avatars/npc-explorer.webp'
import npcResearcher from '../assets/avatars/npc-researcher.webp'
import npcReviewer from '../assets/avatars/npc-reviewer.webp'
import npcSlate from '../assets/avatars/npc-slate.webp'

const BUILTIN_NPC_AVATARS = new Map([
  ['npc-explorer', npcExplorer],
  ['npc-researcher', npcResearcher],
  ['npc-executor', npcExecutor],
  ['npc-reviewer', npcReviewer],
])

export function buddyNpcDefaultAvatar(buddyId?: string) {
  return BUILTIN_NPC_AVATARS.get(buddyId ?? '') ?? npcSlate
}
