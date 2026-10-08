import type { ConversationRepository } from '../../../storage/conversationRepository'
import type { RunInputRepository } from '../../../storage/runInputRepository'
import { describe, expect, it, vi } from 'vitest'
import { createSessionAskCapability } from '../sessionAskExtension'

describe('referenced session search capability', () => {
  it('finds matching Chinese history using the active branch', async () => {
    const current = conversation('current', 'space-1')
    const target = conversation('target', null)
    const conversations = {
      findById: vi.fn((id: string) => id === current.id ? current : id === target.id ? target : null),
      listMessagePage: vi.fn(() => ({
        items: [{
          id: 'message-1',
          role: 'assistant',
          content: '订单延期两周，原因是供应链受阻。',
          createdAt: '2026-09-01T00:00:00.000Z',
        }],
        nextBeforeMessageId: null,
      })),
    } as unknown as Pick<ConversationRepository, 'findById' | 'listMessagePage'>
    const runInputs = {
      findByRunId: vi.fn(() => ({
        contextItems: [{ kind: 'sessionReference', value: target.id, title: 'Clipboard title' }],
      })),
    } as unknown as Pick<RunInputRepository, 'findByRunId'>
    const capability = createSessionAskCapability({
      conversationId: current.id,
      conversations,
      getRunId: () => 'run-1',
      runInputs,
    })
    const registeredTools: unknown[] = []
    capability.extension.factory({
      registerTool: (tool: unknown) => registeredTools.push(tool),
    } as never)
    const tool = registeredTools[0] as {
      execute: (toolCallId: string, input: { question: string }, signal: AbortSignal) => Promise<{
        content: { type: string, text: string }[]
        details: { count: number }
      }>
    }

    const result = await tool.execute('tool-1', { question: '订单为什么延期？' }, new AbortController().signal)

    expect(conversations.listMessagePage).toHaveBeenCalledWith(target.id, target.activeBranchId, { beforeMessageId: undefined, limit: 500 })
    expect(result.details.count).toBe(1)
    expect(JSON.parse(result.content[0]!.text)).toMatchObject([{
      sessionId: target.id,
      title: target.title,
      messageId: 'message-1',
      excerpt: '订单延期两周，原因是供应链受阻。',
    }])
  })

  it('reads an explicitly referenced session from another Space', async () => {
    const current = conversation('current', 'space-1')
    const target = conversation('target', 'space-2')
    const listMessagePage = vi.fn(() => ({
      items: [{
        id: 'message-cross-space',
        role: 'assistant',
        content: 'The decision was to ship next week.',
        createdAt: '2026-09-01T00:00:00.000Z',
      }],
      nextBeforeMessageId: null,
    }))
    const conversations = {
      findById: vi.fn((id: string) => id === current.id ? current : id === target.id ? target : null),
      listMessagePage,
    } as unknown as Pick<ConversationRepository, 'findById' | 'listMessagePage'>
    const runInputs = {
      findByRunId: vi.fn(() => ({
        contextItems: [{ kind: 'sessionReference', value: target.id, title: target.title }],
      })),
    } as unknown as Pick<RunInputRepository, 'findByRunId'>
    const capability = createSessionAskCapability({
      conversationId: current.id,
      conversations,
      getRunId: () => 'run-1',
      runInputs,
    })
    const registeredTools: unknown[] = []
    capability.extension.factory({ registerTool: (tool: unknown) => registeredTools.push(tool) } as never)
    const tool = registeredTools[0] as {
      execute: (toolCallId: string, input: { question: string }, signal: AbortSignal) => Promise<{
        content: { type: string, text: string }[]
        details: { count: number }
      }>
    }

    const result = await tool.execute('tool-1', { question: 'What was the decision?' }, new AbortController().signal)

    expect(listMessagePage).toHaveBeenCalledWith(target.id, target.activeBranchId, { beforeMessageId: undefined, limit: 500 })
    expect(result.details.count).toBe(1)
    expect(JSON.parse(result.content[0]!.text)).toMatchObject([{ sessionId: target.id, messageId: 'message-cross-space' }])
  })
})

function conversation(id: string, spaceId: string | null) {
  return {
    activeBranchId: `${id}-branch`,
    deletedAt: null,
    id,
    spaceId,
    title: `${id} title`,
  }
}
