import type { LocalConversationSummary } from '@buddy-shared/conversation/conversationApi'
import type { LocalSpace } from '@buddy-shared/spaces/spaceApi'
import { describe, expect, it } from 'vitest'
import {
  DESKTOP_TASK_SIDEBAR_CONVERSATION_LIMIT,
  DESKTOP_TASK_SIDEBAR_TASKS_GROUP_KEY,
  resolveTaskIndexProjection,
  spaceConversationGroupKey,
} from '../taskPinnedItems'

function createTask(id: string, spaceId: string | null): LocalConversationSummary {
  return {
    id,
    spaceId,
    title: id,
    updatedAt: '2026-09-29T00:00:00.000Z',
    activity: 'idle',
  } as LocalConversationSummary
}

function createSpace(id: string): LocalSpace {
  return {
    id,
    name: id,
    icon: null,
    iconColor: null,
    primaryDirectory: null,
    revokedAt: null,
  } as unknown as LocalSpace
}

describe('taskIndexProjection pinned conversations', () => {
  it('pins a conversation that belongs to a Space', () => {
    const projection = resolveTaskIndexProjection({
      expandedSpaceIds: new Set(['space-a']),
      pinnedItems: [{ kind: 'conversation', id: 'task-a1' }],
      spaces: [createSpace('space-a')],
      tasks: [createTask('task-a1', 'space-a'), createTask('task-a2', 'space-a')],
    })

    expect(projection.pinnedRows).toEqual([
      { task: expect.objectContaining({ id: 'task-a1' }), key: 'pinned:conversation:task-a1', kind: 'task', pinKey: 'conversation:task-a1', pinnedTopLevel: true },
    ])
    expect(projection.spaceRows.flatMap(row => row.kind === 'task' ? [row.task.id] : [])).toEqual(['task-a2'])
  })

  it('keeps a pinned Space conversation out of the pinned Space expansion', () => {
    const projection = resolveTaskIndexProjection({
      expandedSpaceIds: new Set(['space-a']),
      pinnedItems: [{ kind: 'space', id: 'space-a' }, { kind: 'conversation', id: 'task-a1' }],
      spaces: [createSpace('space-a')],
      tasks: [createTask('task-a1', 'space-a'), createTask('task-a2', 'space-a')],
    })

    expect(projection.pinnedRows.map(row => row.key)).toEqual([
      'pinned:space:space-a',
      'pinned:space:space-a:conversation:task-a2',
      'pinned:conversation:task-a1',
    ])
  })

  it('drops pinned conversations that no longer exist', () => {
    const projection = resolveTaskIndexProjection({
      expandedSpaceIds: new Set(['space-a']),
      pinnedItems: [{ kind: 'conversation', id: 'task-gone' }],
      spaces: [createSpace('space-a')],
      tasks: [createTask('task-a1', 'space-a')],
    })

    expect(projection.pinnedRows).toEqual([])
  })
})

describe('taskIndexProjection conversation limit', () => {
  const tasks = Array.from({ length: 8 }, (_, index) => createTask(`task-${index}`, null))

  it('caps the tasks group and appends an expand row with the remaining count', () => {
    const projection = resolveTaskIndexProjection({
      expandedSpaceIds: new Set(),
      pinnedItems: [],
      spaces: [],
      tasks,
    })

    expect(projection.taskRows).toHaveLength(DESKTOP_TASK_SIDEBAR_CONVERSATION_LIMIT + 1)
    expect(projection.taskRows.at(-1)).toEqual({
      groupKey: DESKTOP_TASK_SIDEBAR_TASKS_GROUP_KEY,
      key: `${DESKTOP_TASK_SIDEBAR_TASKS_GROUP_KEY}:expand`,
      kind: 'expand',
      remaining: 8 - DESKTOP_TASK_SIDEBAR_CONVERSATION_LIMIT,
    })
  })

  it('shows every conversation once the group is expanded', () => {
    const projection = resolveTaskIndexProjection({
      expandedConversationGroups: new Set([DESKTOP_TASK_SIDEBAR_TASKS_GROUP_KEY]),
      expandedSpaceIds: new Set(),
      pinnedItems: [],
      spaces: [],
      tasks,
    })

    expect(projection.taskRows).toHaveLength(tasks.length)
    expect(projection.taskRows.some(row => row.kind === 'expand')).toBe(false)
  })

  it('caps a Space conversation list independently', () => {
    const projection = resolveTaskIndexProjection({
      expandedSpaceIds: new Set(['space-a']),
      pinnedItems: [],
      spaces: [createSpace('space-a')],
      tasks: Array.from({ length: 7 }, (_, index) => createTask(`task-a${index}`, 'space-a')),
    })

    const taskRows = projection.spaceRows.filter(row => row.kind !== 'space')
    expect(taskRows).toHaveLength(DESKTOP_TASK_SIDEBAR_CONVERSATION_LIMIT + 1)
    expect(taskRows.at(-1)).toMatchObject({
      groupKey: spaceConversationGroupKey('space-a'),
      kind: 'expand',
      remaining: 2,
    })
  })

  it('does not add an expand row when the group fits the limit', () => {
    const projection = resolveTaskIndexProjection({
      expandedSpaceIds: new Set(),
      pinnedItems: [],
      spaces: [],
      tasks: tasks.slice(0, DESKTOP_TASK_SIDEBAR_CONVERSATION_LIMIT),
    })

    expect(projection.taskRows).toHaveLength(DESKTOP_TASK_SIDEBAR_CONVERSATION_LIMIT)
    expect(projection.taskRows.some(row => row.kind === 'expand')).toBe(false)
  })
})
