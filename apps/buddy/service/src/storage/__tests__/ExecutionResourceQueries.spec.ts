import type { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { ProductContentReferences } from '../../productProtocol/ProductContentReferences'
import { ProductReadViews } from '../../productProtocol/ProductReadViews'
import { ChatControlCommandRepository } from '../ChatControlCommandRepository'
import { openBuddySqliteDatabase } from '../database'
import { ExecutionResourceQueries } from '../ExecutionResourceQueries'
import { sqliteRunFixtureTime as now, seedSqliteRun } from './sqliteRunFixture'

const databases: DatabaseSync[] = []
afterEach(() => {
  for (const database of databases.splice(0)) database.close()
})

function fixture() {
  const database = openBuddySqliteDatabase({ databasePath: ':memory:' })
  databases.push(database)
  const resources = new ExecutionResourceQueries(database)
  return { database, resources }
}

function closed(database: DatabaseSync, id: string, conversationId = 'task-1') {
  seedSqliteRun(database, id, { conversationId })
  database.prepare('UPDATE runs SET status = \'completed\' WHERE id = ?').run(id)
  database.prepare('UPDATE execution_state SET phase = \'closed\', cleanup_state = \'clean\' WHERE run_id = ?').run(id)
}

describe('execution resource release evidence', () => {
  it.each([
    ['completed', 'closing', 'pending', 'occupied'],
    ['completed', 'closed', 'degraded', 'unknown'],
  ])('projects %s / %s / %s as %s consistently', (status, phase, cleanup, expected) => {
    const { database, resources } = fixture()
    closed(database, 'root')
    database.prepare('UPDATE runs SET status = ? WHERE id = ?').run(status!, 'root')
    database.prepare('UPDATE execution_state SET phase = ?, cleanup_state = ? WHERE run_id = ?').run(phase!, cleanup!, 'root')
    expect(resources.subtree('root')).toBe(expected)
    expect(resources.conversation('task-1')).toBe(expected)
    expect(resources.service()).toBe(expected)
  })

  it('distinguishes an empty task from missing execution evidence and scopes batch results', () => {
    const { database, resources } = fixture()
    expect(resources.service()).toBe('released')
    expect(resources.subtree('missing')).toBe('unknown')
    closed(database, 'lost')
    closed(database, 'other', 'task-2')
    database.prepare('DELETE FROM execution_state WHERE run_id = ?').run('lost')
    expect(resources.conversations(['task-1', 'task-2', 'empty'])).toEqual(new Map([
      ['task-1', 'unknown'],
      ['task-2', 'released'],
      ['empty', 'released'],
    ]))
    expect(resources.subtree('lost')).toBe('unknown')
    expect(resources.service()).toBe('unknown')
  })

  it('includes private descendants and mutation leases in public release evidence and cancellation receipts', () => {
    const { database, resources } = fixture()
    closed(database, 'root')
    closed(database, 'child')
    closed(database, 'other', 'task-2')
    database.prepare('UPDATE runs SET parent_run_id = ?, root_run_id = ?, execution_kind = \'npc_child\' WHERE id = ?').run('root', 'root', 'child')
    database.prepare(`INSERT INTO run_mutation_leases (invocation_id, run_id, segment_id, claims_json, status, created_at, updated_at)
      VALUES ('lease', 'child', 'segment', '[]', 'active', ?, ?)`).run(now, now)
    const views = new ProductReadViews(database, 'desktop-local', new ProductContentReferences(database, 'desktop-local'))
    const commands = new ChatControlCommandRepository(database, 'instance')
    for (const [status, expected] of [['active', 'occupied'], ['hazard', 'unknown'], ['released', 'released']]) {
      database.prepare('UPDATE run_mutation_leases SET status = ? WHERE invocation_id = ?').run(status!, 'lease')
      expect(resources.subtree('root')).toBe(expected)
      expect(views.runExecution('root')).toMatchObject({ resources: expected })
      expect(views.runExecution('child')).toBeNull()
      expect(commands.cancelRun({ runId: 'root', expectedRunGeneration: 0 }).result).toEqual({ cancelRequested: false, executionResources: expected })
      expect(commands.stopService({ targetServiceInstanceId: 'instance', scope: 'keep_service' }, 'keep').result.executionResources).toBe(expected)
      expect(resources.conversation('task-2')).toBe('released')
    }
    database.prepare('DELETE FROM execution_state WHERE run_id = ?').run('child')
    expect(views.runExecution('root')).toMatchObject({ resources: 'unknown' })
    expect(commands.stopService({ targetServiceInstanceId: 'instance', scope: 'stop_service' }, 'stop').result).toEqual({ scope: 'stop_service', runIds: [], executionResources: 'unknown' })
  })
})
