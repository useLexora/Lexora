import type { Api, Model } from '@earendil-works/pi-ai'
import type { RunRecord } from '../../../../storage/runRecord'
import type { UsageRecord } from '../../../../storage/usageRepository'
import { describe, expect, it, vi } from 'vitest'
import {
  BuddySessionRecoveryService,
} from '../BuddySessionRecoveryService'

describe('buddySessionRecoveryService', () => {
  it('recovers only the receiving actor input references and never another actor materialized prompt', async () => {
    const history = ['a', 'b'].flatMap(id => [
      message(`user-${id}`, 'user', { text: `Public ${id}`, modelInputText: `Private ${id}` }),
      message(`answer-${id}`, 'assistant', { text: `Answer ${id}` }, `run-${id}`),
    ])
    const service = new BuddySessionRecoveryService({
      conversations: { listBranchMessages: () => history },
      models: { resolve: () => model() },
      usage: { listForRun: () => [] },
      runs: { findById: id => ({ id, threadId: `thread-${id.slice(-1)}`, status: 'completed' }) as RunRecord },
      runInputs: { findByMessageId: id => ({ runId: `run-${id.slice(-1)}`, attachmentIds: [`image-${id.slice(-1)}`], prompt: `Private materialized ${id}`, contextItems: [], reasoning: null, serviceTier: null, createdAt: '2026-10-01T00:00:00.000Z' }) },
      attachments: { resolveRecoveryInputReferences: async ids => ({ documents: [], images: ids.map(attachmentId => ({ attachmentId, mimeType: 'image/png' })), missingAttachmentIds: [] }) },
    })
    const recovered = await service.create({ conversationId: 'conversation-1', branchId: 'branch-1', threadId: 'thread-b', fallbackModel: model(), point: { kind: 'branch_head' } })
    expect(recovered.messages).toHaveLength(2)
    expect(recovered.messages[0]).toMatchObject({ buddyInput: { messageId: 'user-b', prompt: 'Private materialized user-b', images: [{ attachmentId: 'image-b', mimeType: 'image/png' }] } })
    expect(recovered.messages[1]).toMatchObject({ role: 'assistant', content: [{ type: 'text', text: 'Answer b' }] })
    expect(recovered.recoveredImageCount).toBe(1)
    expect(JSON.stringify(recovered)).not.toContain('user-a')
    expect(JSON.stringify(recovered)).not.toContain('image-a')
  })

  it.each([false, true])('preserves delivery evidence when recovering a run with a size error (delivered: %s)', async (delivered) => {
    const service = new BuddySessionRecoveryService({
      attachments: { resolveRecoveryInputReferences: async () => ({ documents: [{ attachmentId: 'audio-1', mimeType: 'audio/wav' }], images: [], missingAttachmentIds: [] }) },
      conversations: { listBranchMessages: () => [message('user-1', 'user', { text: 'Inspect audio' }), message('error-1', 'assistant', { text: '' }, 'run-1')] },
      models: { resolve: () => model() },
      runInputs: { findByMessageId: () => ({ runId: 'run-1', attachmentIds: ['audio-1'], prompt: 'Inspect audio', reasoning: null, serviceTier: null, contextItems: [], createdAt: '2026-09-12T00:00:00.000Z' }) },
      runs: { findById: () => ({ id: 'run-1', status: 'failed', errorCode: 'MODEL_INPUT_TOO_LARGE' }) as RunRecord },
      usage: { listForRun: () => delivered ? [{ totalTokens: 20 } as UsageRecord] : [] },
    })
    const result = await service.create({ conversationId: 'conversation-1', branchId: 'branch-1', fallbackModel: model(), point: { kind: 'branch_head' } })
    if (delivered)
      expect(result.messages[0]).toMatchObject({ buddyInput: { documents: [{ attachmentId: 'audio-1', mimeType: 'audio/wav' }] } })
    else
      expect(result.messages[0]).toMatchObject({ content: expect.stringContaining('MODEL_INPUT_TOO_LARGE') })
  })
  it('uses different product-history boundaries for a turn and a compaction', async () => {
    const history = [
      message('user-1', 'user', { text: 'First question' }),
      message('assistant-1', 'assistant', { text: 'First answer' }, 'run-1'),
      message('user-2', 'user', { text: 'Second question' }),
      message('assistant-2', 'assistant', { text: 'Second answer' }, 'run-2'),
    ]
    const resolveRecoveryInputReferences = vi.fn(async () => ({
      documents: [],
      images: [],
      missingAttachmentIds: [],
    }))
    const service = new BuddySessionRecoveryService({
      usage: { listForRun: () => [] },
      attachments: { resolveRecoveryInputReferences },
      conversations: { listBranchMessages: () => history },
      models: { resolve: () => model() },
      runInputs: {
        findByMessageId: messageId => ({
          attachmentIds: [],
          contextItems: [],
          createdAt: '2026-08-28T00:00:00.000Z',
          prompt: messageId === 'user-1' ? 'First durable prompt' : 'Second durable prompt',
          reasoning: null,
          runId: `run-${messageId}`,
          serviceTier: null,
        }),
      },
      runs: { findById: () => null },
    })

    const turn = await service.create({
      branchId: 'branch-1',
      conversationId: 'conversation-1',
      fallbackModel: model(),
      point: { kind: 'before_message', messageId: 'user-2' },
    })
    const compaction = await service.create({
      branchId: 'branch-1',
      conversationId: 'conversation-1',
      fallbackModel: model(),
      point: { kind: 'branch_head' },
    })

    expect(turn.messages.map(item => item.role)).toEqual(['user', 'assistant'])
    expect((await service.create({ branchId: 'branch-1', conversationId: 'conversation-1', fallbackModel: model(), point: { kind: 'after_message', messageId: 'assistant-1' } })).messages).toEqual(turn.messages)
    expect(compaction.messages.map(item => item.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
    ])
    expect(compaction.messages.at(2)).toMatchObject({
      buddyInput: {
        images: [],
        messageId: 'user-2',
        prompt: 'Second durable prompt',
        version: 1,
      },
      content: [{ text: 'Second durable prompt', type: 'text' }],
      role: 'user',
    })
    await expect(service.create({
      branchId: 'branch-1',
      conversationId: 'conversation-1',
      fallbackModel: model(),
      point: { kind: 'before_message', messageId: 'missing-message' },
    })).rejects.toMatchObject({ code: 'CONVERSATION_BINDING_MISMATCH' })
  })
})

function message(
  id: string,
  role: 'assistant' | 'user',
  content: unknown,
  runId: string | null = null,
) {
  return {
    branchId: 'branch-1',
    content,
    conversationId: 'conversation-1',
    createdAt: '2026-08-28T00:00:00.000Z',
    id,
    role,
    runId,
  }
}

function model(): Model<Api> {
  return {
    api: 'anthropic-messages',
    baseUrl: 'https://example.test',
    contextWindow: 200_000,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
    id: 'model-1',
    input: ['text'],
    maxTokens: 8_192,
    name: 'Model',
    provider: 'provider-1',
    reasoning: false,
  }
}
