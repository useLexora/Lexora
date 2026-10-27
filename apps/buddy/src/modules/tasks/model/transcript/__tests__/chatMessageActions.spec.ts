import type { ChatTranscriptMessageRow, ChatTranscriptTurnResultRow } from '../chatTranscriptTypes'
import { describe, expect, it } from 'vitest'
import { getChatMessageFollowupSourceId, projectChatAgentTurnActions, projectChatFollowupMessageIds, projectChatMessageActions } from '../chatMessageActions'

function reply(id: string, runId: string, patch: Partial<ChatTranscriptMessageRow> = {}): ChatTranscriptMessageRow {
  return {
    key: id,
    kind: 'message',
    message: {
      id,
      runId,
      role: 'assistant',
      branchId: 'branch',
      conversationId: 'conversation',
      attachments: [],
      content: { text: id },
      createdAt: '2026-09-08T00:00:00.000Z',
    },
    turnOutputs: null,
    ...patch,
  }
}

function question(id: string): ChatTranscriptMessageRow {
  const row = reply(id, 'unused')
  return { ...row, message: { ...row.message, role: 'user', runId: null } }
}

function result(runId: string, finalMessageId: string): ChatTranscriptTurnResultRow {
  return {
    key: `result-${runId}`,
    kind: 'turn-result',
    turn: {
      branchId: 'branch',
      completedAt: '2026-09-08T00:00:01.000Z',
      finalMessageId,
      nodes: [],
      processMessageIds: [],
      progress: null,
      reasoningLevel: null,
      runId,
      startedAt: '2026-09-08T00:00:00.000Z',
      status: 'completed',
      triggeringMessageId: 'question',
      usage: null,
    },
  }
}

describe('chat turn branch origins', () => {
  it('offers history branching only after another public message, not for the current turn or trailing result metadata', () => {
    const outcome = result('root', 'final')
    const source = reply('final', 'root', { turnResult: outcome.turn })
    const completed = new Set(['root'])
    expect([...projectChatFollowupMessageIds([source], completed)]).toEqual([])
    expect([...projectChatFollowupMessageIds([reply('final', 'root'), outcome], completed)]).toEqual([])
    expect([...projectChatFollowupMessageIds([source, question('next')], completed)]).toEqual(['final'])
    expect(projectChatAgentTurnActions(outcome.turn, false, true).showFollowup).toBe(false)
    expect(projectChatAgentTurnActions(outcome.turn, false, true, true).showFollowup).toBe(true)
  })

  it('keeps branching at the root result even when the toolbar is presented on a partner reply', () => {
    const firstPartner = reply('first-partner-reply', 'first-partner')
    const finalPartner = reply('last-partner-reply', 'last-partner', { turnResult: result('root', 'root-final').turn })
    const completed = new Set(['root', 'first-partner', 'last-partner'])
    expect([...projectChatFollowupMessageIds([firstPartner, finalPartner], completed)]).toEqual([])
    expect([...projectChatFollowupMessageIds([firstPartner, finalPartner, question('next')], completed)]).toEqual(['root-final'])
    expect(getChatMessageFollowupSourceId(firstPartner)).toBeNull()
    expect(getChatMessageFollowupSourceId(finalPartner)).toBe('root-final')
    expect(projectChatMessageActions(firstPartner.message, false, false, true)).toMatchObject({
      showCopy: true,
      showTime: true,
      showRegenerate: false,
      showFollowup: false,
    })
    expect(projectChatMessageActions(finalPartner.message, false, true, true)).toMatchObject({
      showRegenerate: true,
      showFollowup: true,
    })
  })

  it('keeps independent root turns separate while ignoring completed partner replies', () => {
    const rows = [
      reply('root-final', 'root', { turnResult: result('root', 'root-final').turn }),
      reply('partner-final', 'partner'),
      question('second-question'),
      reply('second-final', 'second', { turnResult: result('second', 'second-final').turn }),
      question('next'),
    ]
    expect([...projectChatFollowupMessageIds(rows, new Set(['root', 'second', 'partner']))]).toEqual(['root-final', 'second-final'])
  })

  it('preserves a historical completed result without a visible body, using its own final message as the source', () => {
    const outcome = result('root', 'empty-root-final')
    const partner = reply('partner-final', 'partner')
    expect([...projectChatFollowupMessageIds([partner, outcome], new Set(['root', 'partner']))]).toEqual([])
    expect([...projectChatFollowupMessageIds([partner, outcome, question('next')], new Set(['root', 'partner']))]).toEqual(['empty-root-final'])
  })

  it.each([
    { streaming: true as const },
    { isIntermediate: true as const },
    { showActions: false as const },
  ])('does not branch from an unfinished or hidden result: %j', (patch) => {
    expect([...projectChatFollowupMessageIds([
      reply('last', 'root', { turnResult: result('root', 'last').turn, ...patch }),
      question('next'),
    ], new Set(['root']))]).toEqual([])
  })

  it('keeps turn controls disabled during mutation and excludes messages without an execution', () => {
    const message = reply('final', 'root').message
    expect(projectChatMessageActions(message, true, true, true)).toMatchObject({ disabled: true, showFollowup: true })
    expect(projectChatMessageActions({ ...message, runId: null }, false, true, true).showFollowup).toBe(false)
    expect(projectChatMessageActions({ ...message, role: 'user' }, false, true, true).showFollowup).toBe(false)
  })
})
