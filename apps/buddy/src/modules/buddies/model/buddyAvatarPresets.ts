import type { BUDDY_AVATAR_PRESET_IDS, LocalBuddy } from '@buddy-shared/buddies/buddyApi'
import { BUILTIN_BUDDY_ID } from '@buddy-shared/buddies/buddyApi'
import actorChatGpt from '../assets/avatars/actor-chatgpt.webp'
import actorClassic from '../assets/avatars/actor-classic.webp'
import actorClaude from '../assets/avatars/actor-claude.webp'
import actorDeepSeek from '../assets/avatars/actor-deepseek.webp'
import actorLexora from '../assets/avatars/actor-lexora.webp'
import npcLilac from '../assets/avatars/npc-lilac.webp'
import npcSlate from '../assets/avatars/npc-slate.webp'

export interface BuddyAvatarPreset {
  id: typeof BUDDY_AVATAR_PRESET_IDS[number]
  kind: LocalBuddy['kind']
  label: 'avatarLexora' | 'avatarClassic' | 'avatarClaude' | 'avatarDeepSeek' | 'avatarChatGpt' | 'avatarNpcSlate' | 'avatarNpcLilac'
  src: string
}

export const BUDDY_AVATAR_PRESETS: readonly BuddyAvatarPreset[] = [
  { id: 'actor-lexora', kind: 'actor', label: 'avatarLexora', src: actorLexora },
  { id: 'actor-classic', kind: 'actor', label: 'avatarClassic', src: actorClassic },
  { id: 'actor-claude', kind: 'actor', label: 'avatarClaude', src: actorClaude },
  { id: 'actor-deepseek', kind: 'actor', label: 'avatarDeepSeek', src: actorDeepSeek },
  { id: 'actor-chatgpt', kind: 'actor', label: 'avatarChatGpt', src: actorChatGpt },
  { id: 'npc-slate', kind: 'npc', label: 'avatarNpcSlate', src: npcSlate },
  { id: 'npc-lilac', kind: 'npc', label: 'avatarNpcLilac', src: npcLilac },
]

export const DEFAULT_ACTOR_AVATAR = actorLexora

export function buddyPresetAvatar(id: BuddyAvatarPreset['id']) {
  return `preset:${id}` as const
}

export function resolveBuddyAvatar(source: string) {
  return BUDDY_AVATAR_PRESETS.find(preset => buddyPresetAvatar(preset.id) === source)?.src ?? source
}

export function defaultBuddyAvatar(kind: LocalBuddy['kind'], buddyId?: string) {
  if (buddyId === BUILTIN_BUDDY_ID || (kind === 'npc' && buddyId))
    return null
  return buddyPresetAvatar(buddyAvatarPresets(kind)[0]!.id)
}

export function buddyAvatarPresets(kind: LocalBuddy['kind']) {
  return BUDDY_AVATAR_PRESETS.filter(preset => preset.kind === kind)
}
