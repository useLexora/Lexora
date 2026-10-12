import { afterEach, expect, it } from 'vitest'
import { createExecutionStorageFixture, executionNow } from './executionFixture'

const fixtures: ReturnType<typeof createExecutionStorageFixture>[] = []
afterEach(() => fixtures.splice(0).forEach(f => f.database.close()))

it('keeps stable member threads and separates journals and latest contexts by actor and NPC call', () => {
  const f = createExecutionStorageFixture()
  fixtures.push(f)
  const original = f.threads.ensureActor('conversation', 'default', executionNow)
  f.executions.admitChild(f.child('actor-child', f.actor.id))
  const actor = f.executions.find('actor-child')!.run
  f.executions.admitChild(f.child('npc-1'))
  f.executions.admitChild(f.child('npc-2'))
  const npc1 = f.executions.find('npc-1')!.run
  const npc2 = f.executions.find('npc-2')!.run
  expect(new Set([original.id, actor.threadId, npc1.threadId, npc2.threadId]).size).toBe(4)
  f.threads.bind(original.id, '/fixture/a.jsonl', 'root-a')
  f.threads.bind(actor.threadId, '/fixture/b.jsonl', 'root-b')
  expect(() => f.threads.bind(npc1.threadId, '/fixture/b.jsonl', 'root-b')).toThrow()
  f.runs.bindSession('root', '/fixture/a.jsonl')
  f.runs.bindSession('actor-child', '/fixture/b.jsonl')
  f.conversations.addMember({ id: 'conversation', buddyId: f.actor.id, updatedAt: executionNow })
  f.conversations.setBuddy({ id: 'conversation', buddyId: f.actor.id, updatedAt: executionNow })
  expect(f.threads.ensureActor('conversation', 'default', executionNow).id).toBe(original.id)
  expect(f.threads.ensureActor('conversation', f.actor.id, executionNow).id).toBe(actor.threadId)
  expect(f.runs.findLatestForThread(original.id, 'branch')?.id).toBe('root')
  expect(f.runs.findLatestForThread(actor.threadId, 'branch')?.id).toBe('actor-child')
  expect(f.threads.findBinding(actor.threadId)).toMatchObject({ sessionFile: '/fixture/b.jsonl', rootEntryId: 'root-b' })
})
