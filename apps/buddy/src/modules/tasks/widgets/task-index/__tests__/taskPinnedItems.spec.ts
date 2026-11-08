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
    activity,
  } as LocalConversationSummary
}

describe('resolveSpaceActivities', () => {
  it('prioritizes approval, then user answers, then running regardless of task order', () => {
    const tasks = [createTask('working', 'space', 'running'), createTask('waiting', 'space', 'running')]
    const activities = new Map([['waiting', 'awaiting_answer' as const]])
    expect(resolveSpaceActivities(tasks, activities).get('space')).toBe('awaiting_answer')
    expect(resolveSpaceActivities(tasks.toReversed(), activities).get('space')).toBe('awaiting_answer')
    const approval = createTask('approval', 'space', 'awaiting_approval')
    expect(resolveSpaceActivities([...tasks, approval], activities).get('space')).toBe('awaiting_approval')
    expect(resolveSpaceActivities([approval, ...tasks], activities).get('space')).toBe('awaiting_approval')
  })

  it('summarizes each Space with its most urgent activity', () => {
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

    expect(Object.fromEntries(resolveSpaceActivities(tasks))).toEqual({
      'space-a': 'awaiting_approval',
      'space-b': 'running',
      'space-c': 'awaiting_approval',
    })
  })
})
