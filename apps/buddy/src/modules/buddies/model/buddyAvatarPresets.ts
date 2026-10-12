import type { LocalBuddy } from '@buddy-shared/buddies/buddyApi'
import actorChatGpt from '../assets/avatars/actor-chatgpt.webp'
import actorClaude from '../assets/avatars/actor-claude.webp'
import actorDeepSeek from '../assets/avatars/actor-deepseek.webp'
import actorLexora from '../assets/avatars/actor-lexora.webp'
import npcLilac from '../assets/avatars/npc-lilac.webp'
import npcSlate from '../assets/avatars/npc-slate.webp'

export interface BuddyAvatarPreset {
  id: string
  kind: LocalBuddy['kind']
  label: 'avatarLexora' | 'avatarClaude' | 'avatarDeepSeek' | 'avatarChatGpt' | 'avatarNpcSlate' | 'avatarNpcLilac'
  src: string
}

export const BUDDY_AVATAR_PRESETS: readonly BuddyAvatarPreset[] = [
  { id: 'actor-lexora', kind: 'actor', label: 'avatarLexora', src: actorLexora },
  { id: 'actor-claude', kind: 'actor', label: 'avatarClaude', src: actorClaude },
  { id: 'actor-deepseek', kind: 'actor', label: 'avatarDeepSeek', src: actorDeepSeek },
  { id: 'actor-chatgpt', kind: 'actor', label: 'avatarChatGpt', src: actorChatGpt },
  { id: 'npc-slate', kind: 'npc', label: 'avatarNpcSlate', src: npcSlate },
  { id: 'npc-lilac', kind: 'npc', label: 'avatarNpcLilac', src: npcLilac },
]

export function buddyAvatarPresets(kind: LocalBuddy['kind']) {
  return BUDDY_AVATAR_PRESETS.filter(preset => preset.kind === kind)
}
