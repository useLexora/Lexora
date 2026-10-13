import type { LocalConversationBranch, LocalConversationTimelineItem } from '@buddy-shared/conversation/conversationApi'

import type { ChatAgentTurn } from '../chatStreamingMessage'
import { describe, expect, it } from 'vitest'
import { projectChatMessageActions } from '../chatMessageActions'

import {
  projectChatMessageBranchNavigators,
} from '../chatMessageBranches'
import { projectPersistedChatTranscriptRows } from '../chatTranscriptProjection'

describe('projectChatMessageBranchNavigators', () => {
  it('attaches assistant retry siblings to the final result after process narration', () => {
    const user = message('user-1', 'user', 'branch-root')
    const process = message('assistant-process', 'assistant', 'branch-retry', 'run-retry')
    const final = message('assistant-final', 'assistant', 'branch-retry', 'run-retry')
    const turn: ChatAgentTurn = {
      branchId: 'branch-retry',
      completedAt: '2026-08-20T00:00:03.000Z',
      finalMessageId: final.id,
      nodes: [{
        id: `process-text:${process.id}`,
        kind: 'text',
        messageId: process.id,
        phase: 'commentary',
        text: 'Preparing the retry result',
      }],
      processMessageIds: [process.id],
      usage: null,
      progress: null,
      reasoningLevel: null,
      runId: 'run-retry',
      startedAt: '2026-08-20T00:00:02.000Z',
      status: 'completed',
      triggeringMessageId: user.id,
    }
    const actual = projectChatMessageBranchNavigators(
      projectPersistedChatTranscriptRows([user, process, final], [turn]),
      [
        branch('branch-root', null, null, 1),
        branch('branch-retry', 'branch-root', 'user-1', 2),
      ],
      'branch-retry',
    )

    expect(actual.get('assistant-final')).toEqual({
      activeBranchId: 'branch-retry',
      count: 2,
      index: 2,
      nextBranchId: null,
      previousBranchId: 'branch-root',
    })
    expect(actual.has('assistant-process')).toBe(false)
  })

  it('keeps repeated regenerations at the same message node in one version group', () => {
    const final = message('assistant-4', 'assistant', 'branch-retry-3')
    const turn: ChatAgentTurn = {
      branchId: final.branchId,
      completedAt: final.createdAt,
      finalMessageId: final.id,
      nodes: [],
      processMessageIds: [],
      usage: null,
      progress: null,
      reasoningLevel: null,
      runId: final.runId!,
      startedAt: final.createdAt,
      status: 'completed',
      triggeringMessageId: 'user-1',
    }
    const actual = projectChatMessageBranchNavigators(
      projectPersistedChatTranscriptRows([
        message('user-1', 'user', 'branch-root'),
        message('actor-reply', 'assistant', 'branch-retry-3', 'actor-run'),
        final,
      ], [turn]),
      [
        branch('branch-root', null, null, 1),
        branch('branch-retry-1', 'branch-root', 'user-1', 2),
        branch('branch-retry-2', 'branch-root', 'user-1', 3),
        branch('branch-retry-3', 'branch-retry-2', 'user-1', 4),
      ],
      'branch-retry-3',
    )

    expect(actual.get('assistant-4')).toEqual({
      activeBranchId: 'branch-retry-3',
      count: 4,
      index: 4,
      nextBranchId: null,
      previousBranchId: 'branch-retry-2',
    })
    expect(actual.has('actor-reply')).toBe(false)
    expect(projectChatMessageActions(message('actor-reply', 'assistant', 'branch-retry-3', 'actor-run'), false, false)).toMatchObject({ showCopy: true, showTime: true, showRegenerate: false })
    expect(projectChatMessageActions(final, false, true).showRegenerate).toBe(true)
  })

  it.each(['failed', 'cancelled'] as const)('keeps retry navigation on a %s turn without a visible result', (status) => {
    const user = message('user-1', 'user', 'branch-root')
    const emptyFinal = {
      ...message('assistant-empty', 'assistant', 'branch-root', `run-${status}`),
      content: { text: '' },
    }
    const turn: ChatAgentTurn = {
      branchId: 'branch-root',
      completedAt: '2026-08-20T00:00:02.000Z',
      finalMessageId: status === 'cancelled' ? emptyFinal.id : null,
      nodes: [],
      processMessageIds: [],
      usage: null,
      progress: null,
      reasoningLevel: null,
      runId: `run-${status}`,
      startedAt: '2026-08-20T00:00:01.000Z',
      status,
      triggeringMessageId: user.id,
    }
    const actual = projectChatMessageBranchNavigators(
      projectPersistedChatTranscriptRows(status === 'cancelled' ? [user, emptyFinal] : [user], [turn]),
      [
        branch('branch-root', null, null, 1),
        branch('branch-retry', 'branch-root', user.id, 2),
      ],
      'branch-root',
    )

    expect(actual.get(turn.runId)).toEqual({
      activeBranchId: 'branch-root',
      count: 2,
      index: 1,
      nextBranchId: 'branch-retry',
      previousBranchId: null,
    })
  })

  it('attaches edited user-input siblings to the edited user message', () => {
    const actual = projectChatMessageBranchNavigators(
      projectPersistedChatTranscriptRows([
        message('user-1', 'user', 'branch-root'),
        message('assistant-1', 'assistant', 'branch-root'),
        message('user-2-edited', 'user', 'branch-edit-2'),
      ], []),
      [
        branch('branch-root', null, null, 1),
        branch('branch-edit-1', 'branch-root', 'assistant-1', 2),
        branch('branch-edit-2', 'branch-root', 'assistant-1', 3),
      ],
      'branch-edit-2',
    )

    expect(actual.get('user-2-edited')).toEqual({
      activeBranchId: 'branch-edit-2',
      count: 3,
      index: 3,
      nextBranchId: null,
      previousBranchId: 'branch-edit-1',
    })
    expect(actual.has('assistant-1')).toBe(false)
  })

  it('treats edited first inputs as sibling root branches', () => {
    const actual = projectChatMessageBranchNavigators(
      projectPersistedChatTranscriptRows([
        message('user-1-edited', 'user', 'branch-root-edit'),
      ], []),
      [
        branch('branch-root', null, null, 1),
        branch('branch-root-edit', null, null, 2),
      ],
      'branch-root-edit',
    )

    expect(actual.get('user-1-edited')).toEqual({
      activeBranchId: 'branch-root-edit',
      count: 2,
      index: 2,
      nextBranchId: null,
      previousBranchId: 'branch-root',
    })
  })
})

function branch(
  id: string,
  parentBranchId: string | null,
  forkedFromMessageId: string | null,
  second: number,
): LocalConversationBranch {
  return {
    conversationId: 'conversation-1',
    createdAt: `2026-08-20T00:00:0${second}.000Z`,
    forkedFromMessageId,
    id,
    parentBranchId,
  }
}

function message(
  id: string,
  role: 'assistant' | 'user',
  branchId: string,
  runId = role === 'assistant' ? `run-${id}` : null,
): Extract<LocalConversationTimelineItem, { kind: 'message' }> {
  return {
    attachments: [],
    branchId,
    content: { text: id },
    conversationId: 'conversation-1',
    createdAt: '2026-08-20T00:00:00.000Z',
    id,
    kind: 'message',
    role,
    runId,
  }
}
