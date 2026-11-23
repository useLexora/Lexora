import type { LocalConversationSummary } from '@buddy-shared/conversation/conversationApi'
import { describe, expect, it } from 'vitest'
import { resolveSpaceActivities } from '../taskPinnedItems'

function createTask(
  id: string,
  spaceId: string | null,
  activity: LocalConversationSummary['activity'],
): LocalConversationSummary {
  return {
    id,
    spaceId,
    title: id,
    updatedAt: '2026-09-29T00:00:00.000Z',
    lastActivityAt: '2026-09-29T00:00:00.000Z',
    activity,
  } as LocalConversationSummary
}

describe('resolveSpaceActivities', () => {
  it('summarizes each Space with its most urgent activity regardless of task order', () => {
    const tasks = [
      createTask('task-a1', 'space-a', 'running'),
      createTask('task-a2', 'space-a', 'awaiting_approval'),
      createTask('task-b1', 'space-b', 'running'),
      createTask('task-b2', 'space-b', 'running'),
      createTask('task-c1', 'space-c', 'awaiting_approval'),
      createTask('task-c2', 'space-c', 'running'),
      createTask('task-d1', 'space-d', 'idle'),
      createTask('task-global', null, 'awaiting_approval'),
    ]
    const activities = new Map([['task-b1', 'awaiting_answer' as const]])
    const expected = {
      'space-a': 'awaiting_approval',
      'space-b': 'awaiting_answer',
      'space-c': 'awaiting_approval',
    }

    expect(Object.fromEntries(resolveSpaceActivities(tasks, activities))).toEqual(expected)
    expect(Object.fromEntries(resolveSpaceActivities(tasks.toReversed(), activities))).toEqual(expected)
  })
})
