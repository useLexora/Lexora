import type { RunContinuityCommit } from '../RunContinuityService'
import { describe, expect, it } from 'vitest'
import { createConversationRepository } from '../../storage/conversationRepository'
import { openBuddyDatabase } from '../../storage/database'
import { createRunRepository } from '../../storage/runRepository'
import { RunContinuityService } from '../RunContinuityService'

describe('run continuity commits', () => {
  it('clears only the actual conversation, branch and file binding without duplicate facts', () => {
    const f = fixture()
    try {
      f.service.bindSession('a-one', '/private/session.jsonl')
      f.service.bindSession('a-one', '/private/session.jsonl')
      f.service.bindSession('a-two', '/private/session.jsonl')
      f.service.bindSession('a-other-branch', '/private/session.jsonl')
      f.service.bindSession('a-other-file', '/private/other.jsonl')
      f.service.bindSession('b-one', '/private/session.jsonl')
      expect(f.events).toHaveLength(5)
      expect(f.service.clearForRun('a-one')).toBe(2)
      expect(f.events.at(-1)).toMatchObject({ kind: 'cleared', conversationId: 'a', branchId: 'a-root', runIds: ['a-one', 'a-two'] })
      expect(f.service.clearForRun('a-one')).toBe(0)
      expect(f.events).toHaveLength(6)
      expect(f.runs.findById('a-two')?.piSessionFile).toBeNull()
      expect(f.runs.findById('a-other-branch')?.piSessionFile).toBe('/private/session.jsonl')
      expect(f.runs.findById('a-other-file')?.piSessionFile).toBe('/private/other.jsonl')
      expect(f.runs.findById('b-one')?.piSessionFile).toBe('/private/session.jsonl')
      expect(JSON.stringify(f.events)).not.toContain('/private/')
      expect(Reflect.set(f.events.at(-1)!.runIds, '0', 'changed')).toBe(false)
    }
    finally { f.close() }
  })

  it('leaves every binding intact and emits no clear when the clearing transaction rolls back', () => {
    const f = fixture()
    try {
      f.service.bindSession('a-one', '/private/session.jsonl')
      f.service.bindSession('a-two', '/private/session.jsonl')
      f.database.exec('CREATE TRIGGER fail_clear BEFORE UPDATE OF pi_session_file ON runs WHEN NEW.id = \'a-two\' AND NEW.pi_session_file IS NULL BEGIN SELECT RAISE(ABORT, \'Fixture clear failure\'); END')
      expect(() => f.service.clearForRun('a-one')).toThrow('Fixture clear failure')
      expect(f.events.map(event => event.kind)).toEqual(['bound', 'bound'])
      expect(f.runs.findById('a-one')?.piSessionFile).toBe('/private/session.jsonl')
      expect(f.runs.findById('a-two')?.piSessionFile).toBe('/private/session.jsonl')
    }
    finally { f.close() }
  })
})

function fixture() {
  const database = openBuddyDatabase({ databasePath: ':memory:' })
  const conversations = createConversationRepository(database)
  const runs = createRunRepository(database)
  const now = '2026-09-28T00:00:00.000Z'
  for (const id of ['a', 'b']) {
    conversations.create({ id, branchId: `${id}-root`, title: id, spaceId: null, createdAt: now, approvalPolicy: 'policy', executionProfile: 'workspace_write' })
    conversations.createMessage({ id: `${id}-question`, branchId: `${id}-root`, conversationId: id, role: 'user', runId: null, content: { text: 'Fixture' }, createdAt: now })
  }
  conversations.createBranch({ id: 'a-branch', conversationId: 'a', parentBranchId: 'a-root', forkedFromMessageId: 'a-question', activate: false, createdAt: now })
  for (const [id, conversationId, branchId] of [['a-one', 'a', 'a-root'], ['a-two', 'a', 'a-root'], ['a-other-branch', 'a', 'a-branch'], ['a-other-file', 'a', 'a-root'], ['b-one', 'b', 'b-root']] as const) {
    runs.create({ id, conversationId, branchId, triggeringMessageId: `${conversationId}-question`, provider: 'fixture', model: 'fixture', purpose: 'chat', status: 'completed', piSessionFile: null, startedAt: now, completedAt: now, approvalPolicy: 'policy', executionProfile: 'workspace_write' })
  }
  const service = new RunContinuityService(runs)
  const events: RunContinuityCommit[] = []
  service.onDidCommit(event => events.push(event))
  return { database, runs, service, events, close() {
    service.dispose()
    database.close()
  } }
}
