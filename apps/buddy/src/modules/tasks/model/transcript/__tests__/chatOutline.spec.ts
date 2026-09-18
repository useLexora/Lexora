import type { LocalMessage } from '@buddy-shared/conversation/conversationApi'
import type { ChatTranscriptMessageRow, ChatTranscriptProjection } from '../chatTranscriptProjection'
import { describe, expect, it } from 'vitest'
import { createChatOutlineProjector, projectChatOutlineItems } from '../chatOutline'

function message(id: string, text: string, runId: string | null = null): LocalMessage {
  return {
    id,
    content: { text },
    runId,
    role: 'assistant',
    attachments: [],
    branchId: 'branch',
    conversationId: 'conversation',
    createdAt: '2026-09-18T00:00:00Z',
  }
}

function row(value: LocalMessage): ChatTranscriptMessageRow {
  return { key: `message:${value.id}`, kind: 'message', message: value, turnOutputs: null }
}

describe('chat outline projection', () => {
  it.each([
    '  短\n\t摘要  ',
    `${'x'.repeat(120)}   `,
    `${'x'.repeat(120)}   y`,
    `${'x'.repeat(119)}   yz`,
    `${'\n\t\u00A0'.repeat(100)}正文`,
    '长回复 '.repeat(50000),
  ])('preserves whitespace normalization and the 120 character preview', (text) => {
    const normalized = text.replace(/\s+/g, ' ').trim()
    expect(projectChatOutlineItems([message('one', text)])[0].text).toBe(normalized.length > 120
      ? `${normalized.slice(0, 120).trimEnd()}…`
      : normalized)
  })

  it('retains the outline while streaming beyond its preview, but updates a changed prefix', () => {
    const projector = createChatOutlineProjector()
    const history = [message('history', '已保存历史')]
    let current = row(message('stream', '原始摘要 '.repeat(100)))
    let projection: ChatTranscriptProjection = { rows: [current], update: { kind: 'replace' } }
    const initial = projector.project(projection, history)
    for (let index = 0; index < 20; index += 1) {
      current = row(message('stream', `${'原始摘要 '.repeat(100)}追加 ${index}`))
      projection = { rows: [current], update: { kind: 'patch', previousRows: projection.rows, patches: [{ index: 0, deleteCount: 1, rows: [current] }] } }
      expect(projector.project(projection, history)).toBe(initial)
    }
    current = row(message('stream', '修订后的摘要'))
    projection = { rows: [current], update: { kind: 'patch', previousRows: projection.rows, patches: [{ index: 0, deleteCount: 1, rows: [current] }] } }
    const updated = projector.project(projection, history)
    expect(updated.map(item => item.text)).toEqual(['已保存历史', '修订后的摘要'])
    expect(updated[0]).toBe(initial[0])
  })

  it('keeps one final output per run and rebuilds after structural or scope changes', () => {
    const projector = createChatOutlineProjector()
    const history = [message('first', '过程', 'run'), message('last', '结果', 'run')]
    const current = row(message('last', '更新结果', 'run'))
    const initial = projector.project({ rows: [current], update: { kind: 'replace' } }, history)
    expect(initial.map(item => item.messageId)).toEqual(['last'])
    const appended = row(message('new', '下一轮', 'next-run'))
    expect(projector.project({ rows: [current, appended], update: { kind: 'replace' } }, history).map(item => item.text))
      .toEqual(['更新结果', '下一轮'])
    expect(projector.project({ rows: [], update: { kind: 'replace' } }, [message('other', '另一分支')]).map(item => item.messageId))
      .toEqual(['other'])
  })
})
