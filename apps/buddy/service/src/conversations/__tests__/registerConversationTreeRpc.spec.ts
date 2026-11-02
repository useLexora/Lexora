import type { RuntimeRequestHandler } from '../../../../shared/runtime/rpcPeer'
import { describe, expect, it } from 'vitest'
import { conversationResponseSchemas } from '../../../../shared/conversation/conversationApi'
import { conversationTreeSchema } from '../../../../shared/conversation/conversationTree'
import { createConversationRepository } from '../../storage/conversationRepository'
import { openBuddyDatabase } from '../../storage/database'
import { createRunRepository } from '../../storage/runRepository'
import { registerConversationTreeRpc } from '../registerConversationTreeRpc'

describe('conversation tree queries', () => {
  it('bounds the overview and reads exactly one input or output without changing the active branch', async () => {
    const database = openBuddyDatabase({ databasePath: ':memory:' })
    try {
      const conversations = createConversationRepository(database)
      const runs = createRunRepository(database)
      const now = '2026-09-09T00:00:00.000Z'
      for (const id of ['conversation', 'other']) {
        conversations.create({ id, branchId: `${id}-root`, createdAt: now, approvalPolicy: 'policy', executionProfile: 'workspace_write', spaceId: null, title: id })
        conversations.createMessage({ id: `${id}-question`, conversationId: id, branchId: `${id}-root`, role: 'user', runId: null, createdAt: now, content: { text: `question ${id}` } })
        runs.create({ id: `${id}-run`, conversationId: id, branchId: `${id}-root`, triggeringMessageId: `${id}-question`, provider: 'provider', model: 'recorded-model', purpose: 'chat', status: 'completed', startedAt: now, completedAt: '2026-09-09T00:00:09.000Z', approvalPolicy: 'policy', executionProfile: 'workspace_write', piSessionFile: null })
        conversations.createMessage({ id: `${id}-answer`, conversationId: id, branchId: `${id}-root`, role: 'assistant', runId: `${id}-run`, createdAt: now, content: { text: `**Opening**\n\n${'full answer '.repeat(1000)}ENDING` } })
      }
      conversations.createBranch({ id: 'alternative', conversationId: 'conversation', parentBranchId: 'conversation-root', forkedFromMessageId: 'conversation-question', createdAt: now, activate: true })
      const recordUsage = database.prepare(`INSERT INTO usage_records (
        id, run_id, source_entry_id, provider, model, purpose,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_tokens,
        input_cost, output_cost, cache_read_cost, cache_write_cost, total_cost, created_at
      ) VALUES (?, 'conversation-run', ?, 'provider', 'recorded-model', 'turn', 40, 10, 60, 20, 130, 0, 0, 0, 0, 0, ?)`)
      recordUsage.run('usage-1', 'entry-1', now)
      recordUsage.run('usage-2', 'entry-2', now)
      const handlers = new Map<string, RuntimeRequestHandler>()
      registerConversationTreeRpc({
        database,
        conversations,
        runs,
        rpc: { onRequest: (method, handler) => {
          handlers.set(method, handler)
          return () => handlers.delete(method)
        } },
        attachments: { listForConversation: () => [] },
        artifacts: { listForConversation: () => [] },
        changes: { listSummariesForRuns: () => [] },
        runInputs: { findByRunId: () => null },
        eventLog: { verifyRun: async () => {}, listForRuns: () => [] },
      })
      const invoke = async (method: string, input: unknown) => await handlers.get(method)!(input)
      const overview = conversationTreeSchema.parse(await invoke('conversations.getTree', { conversationId: 'conversation' }))
      const answer = overview.nodes.find(node => node.kind === 'answer')!
      expect(answer.text.length).toBeLessThanOrEqual(240)
      expect(answer.text).toMatch(/^Opening/)
      expect(answer.text).not.toContain('ENDING')
      expect(answer.metadata).toEqual({
        modelId: 'recorded-model',
        startedAt: now,
        completedAt: '2026-09-09T00:00:09.000Z',
        usage: { inputTokens: 80, outputTokens: 20, cacheReadTokens: 120, cacheWriteTokens: 40 },
      })
      const otherTree = conversationTreeSchema.parse(await invoke('conversations.getTree', { conversationId: 'other' }))
      expect(otherTree.nodes.find(node => node.kind === 'answer')?.metadata?.usage).toBeNull()
      const question = conversationResponseSchemas.timelinePage.parse(await invoke('conversations.getNodeDetail', { conversationId: 'conversation', kind: 'question', messageId: 'conversation-question' }))
      expect(question.items.map(item => item.id)).toEqual(['conversation-question'])
      expect(question.runs).toEqual([])
      const output = conversationResponseSchemas.timelinePage.parse(await invoke('conversations.getNodeDetail', { conversationId: 'conversation', kind: 'answer', runId: 'conversation-run' }))
      expect(output.items.map(item => item.id)).toEqual(['conversation-answer'])
      expect(output.runs.map(run => run.id)).toEqual(['conversation-run'])
      expect(JSON.stringify(output.items)).toContain('ENDING')
      expect(conversations.findById('conversation')?.activeBranchId).toBe('alternative')
      for (const input of [
        { kind: 'question', messageId: 'other-question' },
        { kind: 'question', messageId: 'conversation-answer' },
        { kind: 'answer', runId: 'other-run' },
      ]) {
        await expect(invoke('conversations.getNodeDetail', { conversationId: 'conversation', ...input })).rejects.toThrow()
      }
      conversations.markDeleted('conversation', now)
      await expect(invoke('conversations.getNodeDetail', { conversationId: 'conversation', kind: 'answer', runId: 'conversation-run' })).rejects.toThrow()
    }
    finally {
      database.close()
    }
  })
})
