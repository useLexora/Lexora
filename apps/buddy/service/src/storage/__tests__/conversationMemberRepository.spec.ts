import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it } from 'vitest'
import { createBuddyRepository } from '../buddyRepository'
import { createConversationMemberRepository } from '../conversationMemberRepository'
import { createConversationRepository } from '../conversationRepository'
import { openBuddyDatabase } from '../database'
import { BUDDY_SCHEMA_MIGRATIONS } from '../schema'

const databases: DatabaseSync[] = []
const directories: string[] = []
const now = '2026-10-11T10:00:00.000Z'
const selection = { providerId: 'fixture', modelId: 'model-a', reasoning: null, serviceTier: null }
afterEach(() => {
  for (const database of databases.splice(0))
    database.close()
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true })
})

it('isolates member overrides across switches and preserves in-flight run ownership', () => {
  const database = openBuddyDatabase({ databasePath: ':memory:' })
  databases.push(database)
  const buddies = createBuddyRepository(database)
  const members = createConversationMemberRepository(database)
  const conversations = createConversationRepository(database)
  conversations.create({ id: 'task', branchId: 'branch', title: null, spaceId: null, approvalPolicy: 'policy', executionProfile: 'workspace_write', createdAt: now })
  const other = buddies.create({ name: 'Other' })
  const npc = buddies.create({ name: 'NPC', kind: 'npc' })
  members.setModelSelection({ conversationId: 'task', actorId: 'default', modelSelection: selection, source: 'legacy', updatedAt: now })
  members.join({ conversationId: 'task', actorId: 'default', joinedAt: '2026-10-12T10:00:00.000Z' })
  expect(members.find('task', 'default')).toMatchObject({ modelSelection: selection, modelSelectionSource: 'legacy', joinedAt: now })
  database.prepare('INSERT INTO runs (id, conversation_id, branch_id, triggering_message_id, provider, model, purpose, status, started_at, buddy_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('run', 'task', 'branch', 'input', 'fixture', 'model-a', 'chat', 'running', now, 'default')
  expect(() => conversations.setBuddy({ id: 'task', buddyId: other.id, updatedAt: now })).toThrow(expect.objectContaining({ code: 'BUDDY_NOT_MEMBER' }))
  expect(() => conversations.removeMember({ id: 'task', buddyId: 'default', updatedAt: now })).toThrow(expect.objectContaining({ code: 'BUDDY_LEADER_PROTECTED' }))
  conversations.addMember({ id: 'task', buddyId: other.id, updatedAt: now })
  expect(conversations.setBuddy({ id: 'task', buddyId: other.id, updatedAt: now })?.modelSelection).toBeNull()
  expect(members.list('task').map(member => member.actorId)).toEqual(expect.arrayContaining(['default', other.id]))
  conversations.setModelSelection({ id: 'task', modelSelection: { ...selection, modelId: 'model-b' }, updatedAt: now })
  expect(members.find('task', other.id)).toMatchObject({ modelSelection: { ...selection, modelId: 'model-b' }, modelSelectionSource: 'explicit' })
  expect(conversations.setBuddy({ id: 'task', buddyId: 'default', updatedAt: now })?.modelSelection).toEqual(selection)
  expect(database.prepare('SELECT buddy_id, model FROM runs WHERE id = ?').get('run')).toEqual({ buddy_id: 'default', model: 'model-a' })
  expect(database.prepare('SELECT model_selection_json FROM conversations WHERE id = ?').get('task')).toEqual({ model_selection_json: null })
  expect(() => conversations.setBuddy({ id: 'task', buddyId: npc.id, updatedAt: now })).toThrow(expect.objectContaining({ code: 'BUDDY_NOT_ACTOR' }))
  conversations.removeMember({ id: 'task', buddyId: other.id, updatedAt: now })
  expect(members.find('task', other.id)).toBeNull()
  expect(members.list('task').map(member => member.actorId)).toEqual(['default'])
  conversations.addMember({ id: 'task', buddyId: other.id, updatedAt: now })
  expect(members.find('task', other.id)).toMatchObject({ modelSelection: { ...selection, modelId: 'model-b' }, modelSelectionSource: 'explicit', joinedAt: now })
  const disabled = buddies.update({ buddyId: other.id, expectedRevision: other.revision, enabled: false })
  expect(() => conversations.setBuddy({ id: 'task', buddyId: other.id, updatedAt: now })).toThrow(expect.objectContaining({ code: 'BUDDY_DISABLED' }))
  buddies.delete({ buddyId: other.id, expectedRevision: disabled.revision })
  expect(members.find('task', other.id)?.modelSelection?.modelId).toBe('model-b')
  expect(() => members.setModelSelection({ conversationId: 'task', actorId: other.id, modelSelection: selection, updatedAt: now })).toThrow(expect.objectContaining({ code: 'BUDDY_DELETED' }))
  conversations.setModelSelection({ id: 'task', actorId: 'default', modelSelection: null, updatedAt: now })
  expect(members.find('task', 'default')).toMatchObject({ modelSelection: null, modelSelectionSource: null })
})

it('projects a migrated legacy override from the current member and never reads the retired conversation field', () => {
  const directory = mkdtempSync(join(tmpdir(), 'lexora-member-migration-'))
  directories.push(directory)
  const databasePath = join(directory, 'buddy.sqlite3')
  const legacy = new DatabaseSync(databasePath)
  legacy.exec('PRAGMA foreign_keys = OFF')
  for (const migration of BUDDY_SCHEMA_MIGRATIONS.filter(migration => migration.version <= 25))
    legacy.exec(migration.sql)
  legacy.prepare('INSERT INTO conversations (id, model_selection_json, created_at, updated_at) VALUES (?, ?, ?, ?)').run('task', JSON.stringify(selection), now, now)
  legacy.exec('PRAGMA user_version = 25')
  legacy.close()
  const database = openBuddyDatabase({ databasePath })
  databases.push(database)
  const members = createConversationMemberRepository(database)
  const conversations = createConversationRepository(database)
  expect(members.find('task', 'default')).toMatchObject({ modelSelection: selection, modelSelectionSource: 'legacy' })
  expect(conversations.findById('task')?.modelSelection).toEqual(selection)
  database.prepare('UPDATE conversations SET model_selection_json = ? WHERE id = ?').run(JSON.stringify({ ...selection, modelId: 'obsolete-value' }), 'task')
  expect(conversations.findById('task')?.modelSelection).toEqual(selection)
  conversations.setModelSelection({ id: 'task', modelSelection: { ...selection, modelId: 'new-value' }, updatedAt: now })
  expect(members.find('task', 'default')).toMatchObject({ modelSelection: { ...selection, modelId: 'new-value' }, modelSelectionSource: 'explicit' })
})
