import type { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { createExecutionStorageFixture } from '../../storage/__tests__/executionFixture'
import { openBuddyMigrationCandidate } from '../../storage/database'
import { readProductInputDelivery } from '../readProductInputDelivery'

const databases: DatabaseSync[] = []
afterEach(() => databases.splice(0).forEach(database => database.close()))
function fixture() {
  const f = createExecutionStorageFixture(':memory:', openBuddyMigrationCandidate({ databasePath: ':memory:' }))
  databases.push(f.database)
  return { ...f, read: (behavior: 'queue' | 'steer' = 'steer', branchId = 'branch') => readProductInputDelivery(f.database, { conversationId: 'conversation', branchId }, async () => behavior) }
}

describe('mobile input delivery snapshot', () => {
  it('pins both working delivery preferences to the same recipient and execution', async () => {
    const f = fixture()
    const target = { rootRunId: 'root', runId: 'root' }
    await expect(f.read()).resolves.toEqual({ actorId: 'default', mode: 'current', target })
    await expect(f.read('queue')).resolves.toEqual({ actorId: 'default', mode: 'next', target })
    await expect(f.read('steer', 'unrelated')).rejects.toMatchObject({ code: 'SOURCE_CHANGED' })
  })
  it('binds a leading actor working as a child, never another actor or a private run', async () => {
    const f = fixture()
    f.executions.admitChild(f.child('private'))
    f.database.prepare('UPDATE conversations SET buddy_id = ? WHERE id = ?').run(f.actor.id, 'conversation')
    await expect(f.read('queue')).resolves.toEqual({ actorId: f.actor.id, mode: 'current', target: null })
    f.executions.admitChild(f.child('review', f.actor.id))
    await expect(f.read()).resolves.toEqual({ actorId: f.actor.id, mode: 'current', target: { runId: 'review', rootRunId: 'root' } })
    f.database.prepare('UPDATE execution_state SET phase = ? WHERE run_id = ?').run('closing', 'root')
    await expect(f.read()).rejects.toMatchObject({ code: 'INPUT_DELIVERY_TARGET_UNAVAILABLE' })
  })
  it('does not interpret an execution still cleaning up as idle', async () => {
    const f = fixture()
    f.database.exec('UPDATE runs SET status = \'completed\' WHERE id = \'root\'; UPDATE execution_state SET phase = \'closed\', cleanup_state = \'pending\' WHERE run_id = \'root\'')
    await expect(f.read()).rejects.toMatchObject({ code: 'INPUT_DELIVERY_TARGET_UNAVAILABLE' })
    f.database.exec('UPDATE execution_state SET cleanup_state = \'clean\' WHERE run_id = \'root\'')
    await expect(f.read()).resolves.toEqual({ actorId: 'default', mode: 'current', target: null })
  })
})
