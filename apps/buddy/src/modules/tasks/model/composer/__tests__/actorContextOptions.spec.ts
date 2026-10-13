import type { LocalBuddy } from '@buddy-shared/buddies/buddyApi'
import { DEFAULT_BUDDY_SETTINGS } from '@buddy-shared/buddies/buddySettings'
import { describe, expect, it } from 'vitest'
import { createActorContextOptions } from '../actorContextOptions'

function buddy(id: string, changes: Partial<LocalBuddy> = {}): LocalBuddy {
  return { id, kind: 'actor', enabled: true, name: 'Lexora', avatar: null, customAvatars: [], description: '', deletedAt: null, settings: DEFAULT_BUDDY_SETTINGS, revision: 1, createdAt: '2026-10-11T00:00:00.000Z', updatedAt: '2026-10-11T00:00:00.000Z', ...changes }
}

describe('actor mention choices', () => {
  it('lists only enabled actors while keeping same-name identities and avatar presentation distinct', () => {
    const candidates = createActorContextOptions([
      buddy('one'),
      buddy('two', { avatar: 'data:image/png;base64,AAAA' }),
      buddy('npc', { kind: 'npc' }),
      buddy('disabled', { enabled: false }),
      buddy('removed', { deletedAt: '2026-10-11T01:00:00.000Z' }),
      buddy('other', { name: 'Other actor' }),
    ], 'lex')
    expect(candidates.map(option => option.actorReference)).toEqual([
      { type: 'actor_ref', actorId: 'one', name: 'Lexora' },
      { type: 'actor_ref', actorId: 'two', name: 'Lexora' },
    ])
    expect(candidates.map(option => option.avatar)).toEqual([null, 'data:image/png;base64,AAAA'])
    expect(createActorContextOptions([buddy('one')], 'no match')).toEqual([])
  })
})
