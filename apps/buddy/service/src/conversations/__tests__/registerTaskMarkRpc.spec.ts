import type { RuntimeRequestHandler } from '../../../../shared/runtime/rpcPeer'
import { describe, expect, it } from 'vitest'
import { SYSTEM_UNREAD_MARK_ID, taskMarkSchema, taskMarkStateSchema } from '../../../../shared/conversation/taskMarkApi'
import { createConversationRepository } from '../../storage/conversationRepository'
import { openBuddyDatabase } from '../../storage/database'
import { createTaskMarkRepository } from '../../storage/taskMarkRepository'
import { registerTaskMarkRpc } from '../registerTaskMarkRpc'
import { TaskMarkService } from '../TaskMarkService'

describe('task mark RPC boundary', () => {
  it('clears a task through a strict versioned request without deleting its mark definition', async () => {
    const database = openBuddyDatabase({ databasePath: ':memory:' })
    const repository = createTaskMarkRepository(database)
    const handlers = new Map<string, RuntimeRequestHandler>()
    const stop = registerTaskMarkRpc({ onRequest: (method, handler) => {
      handlers.set(method, handler)
      return () => handlers.delete(method)
    } }, new TaskMarkService(repository), repository)
    try {
      createConversationRepository(database).create({ id: 'a', branchId: 'branch-a', title: '测试', createdAt: '2026-09-12T00:00:00.000Z', spaceId: null, approvalPolicy: 'policy', executionProfile: 'workspace_write' })
      const mark = repository.create({ name: '待检查', description: '', color: '#3979d6' })
      repository.assign('a', mark.id)
      const state = repository.setRead({ ...repository.getState('a'), read: false })
      const input = { conversationId: 'a', resultRunId: state.resultRunId, readRevision: state.readRevision }
      const clear = async (value: unknown) => handlers.get('taskMarks.clear')!(value)
      for (const invalid of [{ conversationId: 'a' }, { ...input, readRevision: -1 }, { ...input, read: true }, { ...input, conversationId: 'missing' }])
        await expect(clear(invalid)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
      expect(repository.getState('a')).toEqual(state)
      expect(taskMarkStateSchema.parse(await clear(input))).toEqual({ ...state, markId: null, unread: false, readRevision: state.readRevision + 1 })
      expect(repository.list()).toEqual([mark])
    }
    finally {
      stop()
      database.close()
    }
  })

  it('validates exact character limits and color syntax, allows duplicate names and rejects system mutations', async () => {
    const database = openBuddyDatabase({ databasePath: ':memory:' })
    const handlers = new Map<string, RuntimeRequestHandler>()
    const repository = createTaskMarkRepository(database)
    const stop = registerTaskMarkRpc({ onRequest: (method, handler) => {
      handlers.set(method, handler)
      return () => handlers.delete(method)
    } }, new TaskMarkService(repository), repository)
    const invoke = async (method: string, input: unknown) => handlers.get(method)!(input)
    const valid = { name: '字'.repeat(20), description: '说'.repeat(200), color: '#AABBCC' }
    try {
      const first = taskMarkSchema.parse(await invoke('taskMarks.create', valid))
      const second = taskMarkSchema.parse(await invoke('taskMarks.create', valid))
      expect(first.id).not.toBe(second.id)
      expect(first.color).toBe('#aabbcc')
      expect(taskMarkSchema.parse(await invoke('taskMarks.create', { ...valid, name: '𠮷'.repeat(20) })).name).toHaveLength(40)
      for (const input of [
        { ...valid, name: ' ' },
        { ...valid, name: '字'.repeat(21) },
        { ...valid, description: '说'.repeat(201) },
        { ...valid, color: 'red' },
        { ...valid, color: 'url(https://invalid.example)' },
        { ...valid, id: SYSTEM_UNREAD_MARK_ID },
      ]) {
        await expect(invoke('taskMarks.create', input)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
      }
      await expect(invoke('taskMarks.update', { ...valid, id: SYSTEM_UNREAD_MARK_ID })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
      await expect(invoke('taskMarks.delete', { id: SYSTEM_UNREAD_MARK_ID })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
    }
    finally {
      stop()
      database.close()
    }
  })
})
