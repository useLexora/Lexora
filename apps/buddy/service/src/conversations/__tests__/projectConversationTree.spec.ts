import type { MessageRecord } from '../../storage/conversationHistoryRepository'
import type { RunRecord } from '../../storage/runRecord'
import { describe, expect, it } from 'vitest'
import { createBuddyUserContent } from '../../../../shared/conversation/buddyUserContent'
import { CONVERSATION_QUOTE_PREVIEW_LENGTH, conversationTreeSchema } from '../../../../shared/conversation/conversationTree'
import { projectConversationTree } from '../projectConversationTree'

describe('conversation tree projection', () => {
  it('keeps excerpt-only questions visible in the canvas while retaining the full file snapshot', () => {
    const quote = { id: 'file-quote', text: 'frozen '.repeat(100), source: { kind: 'file' as const, title: 'notes.md', file: { spaceId: 'space', directoryId: 'directory', revision: 1, path: 'notes.md' }, format: 'markdown' as const } }
    const record = { ...message('file-question', 'main', 'user', null, '0'), content: { userContent: { ...createBuddyUserContent(), resourceQuotes: [quote] }, resourceSnapshots: [] } }
    const tree = conversationTreeSchema.parse(projectConversationTree({ conversationId: 'conversation', activeBranchId: 'main', branches: [], messages: [record], runs: [] }))
    expect(tree.nodes[0]?.text).toContain('notes.md: frozen')
    expect(tree.nodes[0]?.text.length).toBeLessThanOrEqual(640)
    expect(record.content.userContent.resourceQuotes[0]).toEqual(quote)
  })
  it('projects bounded quote cards separately from question text, retaining full snapshots in message content', () => {
    const quotes = Array.from({ length: 4 }, (_, index) => ({
      id: `quote-${index}`,
      text: `excerpt ${index} ${'original text '.repeat(40)}`,
      textOffset: index * 10,
      source: { conversationId: 'conversation', branchId: 'main', messageId: 'source', runId: 'source-run', role: 'assistant' as const },
    }))
    const messages = ['question', ''].map((text, index) => ({
      ...message(`q${index}`, 'main', 'user', null, String(index)),
      content: { userContent: { ...createBuddyUserContent(text), quotes }, resourceSnapshots: [] },
    }))
    const tree = conversationTreeSchema.parse(projectConversationTree({ conversationId: 'conversation', activeBranchId: 'main', branches: [], messages, runs: [] }))
    expect(tree.nodes.map(node => node.text)).toEqual(['question', ''])
    for (const node of tree.nodes) {
      expect(node.quoteCount).toBe(4)
      expect(node.quotes).toHaveLength(3)
      expect(node.quotes[0]).toMatchObject({ id: quotes[0]!.id, source: quotes[0]!.source, textOffset: 0 })
      expect(node.quotes[0]!.text).toHaveLength(CONVERSATION_QUOTE_PREVIEW_LENGTH)
      expect(node.quotes[0]!.text.endsWith('…')).toBe(true)
    }
    expect(messages[0]!.content.userContent.quotes[0]!.text).toContain('original text '.repeat(40))
  })

  it('shares retried questions, places followups at the selected answer and retains each failed attempt as a separate answer', () => {
    const branches = [
      { id: 'main', parentBranchId: null, forkedFromMessageId: null },
      { id: 'alternative', parentBranchId: 'main', forkedFromMessageId: 'q1' },
      { id: 'followup', parentBranchId: 'main', forkedFromMessageId: 'a1' },
    ].map(branch => ({ ...branch, conversationId: 'conversation', createdAt: '0' }))
    const messages = [message('q1', 'main', 'user', null, '1'), message('a1', 'main', 'assistant', 'r1', '3'), message('a2', 'alternative', 'assistant', 'r2', '5'), message('q2', 'followup', 'user', null, '6'), message('partial', 'followup', 'assistant', 'failed', '8'), message('a3', 'followup', 'assistant', 'retried', '10')]
    const input = { conversationId: 'conversation', activeBranchId: 'followup', branches, messages, runs: [run('r1', 'main', 'q1', '2'), run('r2', 'alternative', 'q1', '4'), run('failed', 'followup', 'q2', '7', 'failed'), run('retried', 'followup', 'q2', '9')], toolCounts: new Map([['retried', 2]]) }
    const tree = projectConversationTree(input)
    expect(tree.nodes).toHaveLength(6)
    const nodes = new Map(tree.nodes.map(node => [node.id, node]))
    expect(nodes.get('answer:r1')).toMatchObject({ parentId: 'question:q1', active: true })
    expect(nodes.get('answer:r2')).toMatchObject({ parentId: 'question:q1', active: false })
    expect(nodes.get('question:q2')).toMatchObject({ parentId: 'answer:r1', active: true })
    expect(nodes.get('answer:failed')).toMatchObject({
      parentId: 'question:q2',
      runId: 'failed',
      text: 'partial',
      status: 'failed',
      active: false,
      attempts: [{ runId: 'failed', status: 'failed' }],
    })
    expect(nodes.get('answer:retried')).toMatchObject({
      parentId: 'question:q2',
      runId: 'retried',
      text: 'a3',
      toolCount: 2,
      active: true,
      attempts: [{ runId: 'retried', status: 'completed' }],
    })
    expect(tree.headId).toBe('answer:retried')
    expect(projectConversationTree({ ...input, activeBranchId: 'alternative' }).nodes.filter(node => node.active).map(node => node.id))
      .toEqual(['question:q1', 'answer:r2'])
  })
})

function message(id: string, branchId: string, role: MessageRecord['role'], runId: string | null, createdAt: string): MessageRecord {
  return { id, branchId, role, runId, createdAt, conversationId: 'conversation', content: { text: id } }
}

function run(id: string, branchId: string, triggeringMessageId: string, startedAt: string, status: RunRecord['status'] = 'completed'): RunRecord {
  return { id, branchId, triggeringMessageId, startedAt, status, conversationId: 'conversation', purpose: 'chat', provider: 'test', model: 'test', contextWindow: null, maxTokens: null, approvalPolicy: 'policy', executionProfile: 'workspace_write', executionContext: null, completedAt: startedAt, errorCode: null, piSessionFile: null }
}
