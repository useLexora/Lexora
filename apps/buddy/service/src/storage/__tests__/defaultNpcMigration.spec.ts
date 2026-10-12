import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { expect, it } from 'vitest'
import { buddySettingsSchema } from '../../../../shared/buddies/buddySettings'
import { resolveBuddyPlatform } from '../../../../shared/platform'
import { createBuddyRepository } from '../buddyRepository'
import { openBuddyDatabase } from '../database'
import { MIGRATION_TEST_TIMEOUT } from './migrationFixture'

it('seeds four editable NPCs once and preserves later profile, binding and deletion choices across restart', () => {
  const directory = mkdtempSync(join(tmpdir(), 'lexora-npc-migration-'))
  const databasePath = join(directory, 'buddy.sqlite3')
  let database = openBuddyDatabase({ databasePath })
  try {
    const buddies = createBuddyRepository(database)
    expect(buddies.list().buddies.filter(buddy => buddy.kind === 'npc')).toHaveLength(4)
    expect(buddies.get('npc-explorer')).toMatchObject({ name: '探索者(Explorer)', settings: { instructions: expect.stringContaining('You are an explorer.'), tools: { mode: 'selected', ids: expect.arrayContaining([JSON.stringify(['builtin', 'core', resolveBuddyPlatform(process.platform).shell])]) } } })
    const initial = buddies.get('default')
    expect(initial.settings.npcIds).toEqual(['npc-explorer', 'npc-researcher', 'npc-executor', 'npc-reviewer'])
    expect(buddies.get('npc-reviewer').settings).toMatchObject({ model: null, limits: { fileAccess: 'read_only' } })
    expect(buddies.get('npc-executor').settings.limits.fileAccess).toBe('inherit')
    const explorer = buddies.get('npc-explorer')
    buddies.update({ buddyId: explorer.id, expectedRevision: explorer.revision, name: 'Local explorer', enabled: false })
    buddies.update({ buddyId: 'default', expectedRevision: initial.revision, settings: buddySettingsSchema.parse({ ...initial.settings, npcIds: [], npcConcurrency: { mode: 'unlimited' } }) })
    const reviewer = buddies.get('npc-reviewer')
    buddies.delete({ buddyId: reviewer.id, expectedRevision: reviewer.revision })
    const custom = buddies.create({ name: 'Another actor' })
    database.close()
    database = openBuddyDatabase({ databasePath })
    const reopened = createBuddyRepository(database)
    expect(reopened.get('default').settings).toMatchObject({ npcIds: [], npcConcurrency: { mode: 'unlimited' } })
    expect(reopened.get('npc-explorer')).toMatchObject({ name: 'Local explorer', enabled: false })
    expect(reopened.get('npc-reviewer').deletedAt).not.toBeNull()
    expect(reopened.get(custom.id).settings.npcIds).toEqual([])
    expect(reopened.list().buddies.filter(buddy => buddy.kind === 'npc')).toHaveLength(3)
  }
  finally {
    database.close()
    rmSync(directory, { recursive: true, force: true })
  }
}, MIGRATION_TEST_TIMEOUT)
