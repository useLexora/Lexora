import type { DesktopTaskPinnedItem } from '@buddy-electron/shared/desktopApi'
import type { LocalConversationSummary } from '@buddy-shared/conversation/conversationApi'
import type { LocalSpace } from '@buddy-shared/spaces/spaceApi'
import type { TaskHistoryRow } from '../taskPinnedItems'
import { describe, expect, it } from 'vitest'
import { captureTaskHistoryAnchor, resolveNearbyTaskHistoryScopes, resolveTaskHistoryAnchorOffset } from '../taskHistoryViewport'
import { resolveTaskHistoryRows, resolveTaskIndexProjection } from '../taskPinnedItems'

function space(id: string): LocalSpace {
  return { id, name: id, revokedAt: null } as LocalSpace
}

function task(id: string, spaceId: string | null = 'a', updatedAt = '2026-09-01T00:00:00.000Z'): LocalConversationSummary {
  return { id, spaceId, updatedAt, activity: 'idle' } as LocalConversationSummary
}

function projection(input: { pinnedItems?: DesktopTaskPinnedItem[], expanded?: boolean } = {}) {
  return resolveTaskIndexProjection({
    expandedSpaceIds: new Set(input.expanded === false ? [] : ['a']),
    markedTaskIds: new Set(['marked']),
    unreadTaskIds: new Set(['unread']),
    pinnedItems: input.pinnedItems ?? [],
    spaces: [space('a')],
    tasks: [task('new', 'a', '2026-09-03T00:00:00.000Z'), task('old'), task('unread'), task('marked'), task('global', null)],
  })
}

describe('task history projection', () => {
  it('sorts attention before recent activity without cutting the supplied logical window', () => {
    const tasks = Array.from({ length: 40 }, (_, index) => task(`task-${index}`))
    const result = resolveTaskIndexProjection({
      expandedSpaceIds: new Set(['a']),
      markedTaskIds: new Set(['task-32']),
      unreadTaskIds: new Set(['task-31']),
      pinnedItems: [],
      spaces: [space('a')],
      tasks,
    })
    expect(result.spaceRows).toHaveLength(41)
    expect(result.spaceRows.filter(row => row.kind === 'task').slice(0, 3).map(row => row.task.id)).toEqual(['task-32', 'task-31', 'task-0'])
    expect(tasks[0]?.id).toBe('task-0')
  })

  it('keeps row identity and scope placeholders when spaces and tasks are pinned', () => {
    const before = projection()
    const after = projection({ pinnedItems: [{ kind: 'space', id: 'a' }, { kind: 'conversation', id: 'global' }] })
    const spaceKeys = before.spaceRows.map(row => row.key)
    expect(spaceKeys).toEqual(['space:a', 'conversation:marked', 'conversation:unread', 'conversation:new', 'conversation:old'])
    const rows = resolveTaskHistoryRows({ projection: after, collapsedSections: new Set(), expandedSpaceIds: new Set(['a']), scopes: new Map() })
    expect(rows.map(row => row.key)).toEqual(['section:pinned', ...spaceKeys, 'more:space:a', 'conversation:global', 'section:spaces', 'section:tasks', 'more:global'])
  })

  it('takes more availability only from scope state and respects explicit collapses', () => {
    const scopes = new Map([
      ['space:a', { initialized: true, loading: false, hasMore: false }],
      ['global', { initialized: true, loading: true, hasMore: true }],
    ])
    const rows = resolveTaskHistoryRows({ projection: projection(), collapsedSections: new Set(), expandedSpaceIds: new Set(['a']), scopes })
    expect(rows.filter(row => row.kind === 'more')).toEqual([{ kind: 'more', key: 'more:global', spaceId: null, initialized: true, loading: true }])
    expect(resolveTaskHistoryRows({ projection: projection({ expanded: false }), collapsedSections: new Set(['tasks']), expandedSpaceIds: new Set(), scopes }).map(row => row.key)).toEqual(['section:spaces', 'space:a', 'section:tasks'])
  })

  it.each([false, true])('preserves loaded rows during background refresh with pinned space %s', (pinned) => {
    const input = {
      projection: projection({ pinnedItems: pinned ? [{ kind: 'space', id: 'a' }] : [] }),
      collapsedSections: new Set<never>(),
      expandedSpaceIds: new Set(['a']),
    }
    const scopes = (loading: boolean) => new Map(['space:a', 'global'].map(key => [key, { initialized: true, loading, hasMore: false }]))
    const before = resolveTaskHistoryRows({ ...input, scopes: scopes(false) })
    const refreshing = resolveTaskHistoryRows({ ...input, scopes: scopes(true) })
    expect(before.filter(row => row.kind === 'task')).toHaveLength(5)
    expect(refreshing).toEqual(before)
    expect(resolveTaskHistoryRows({ ...input, scopes: scopes(false) })).toEqual(before)
  })

  it('hides empty pins while retaining the space and task categories', () => {
    const empty = resolveTaskIndexProjection({ expandedSpaceIds: new Set(), markedTaskIds: new Set(), unreadTaskIds: new Set(), pinnedItems: [], spaces: [], tasks: [] })
    const rows = resolveTaskHistoryRows({ projection: empty, collapsedSections: new Set(), expandedSpaceIds: new Set(), scopes: new Map([['global', { initialized: true, loading: false, hasMore: false }]]) })
    expect(rows.map(row => row.key)).toEqual(['section:spaces', 'section:tasks'])
  })
})

describe('task history viewport', () => {
  const rows: TaskHistoryRow[] = ['a', 'b', 'c', 'd'].map(id => ({ kind: 'task', key: `conversation:${id}`, task: task(id) }))

  it('preserves row key and the exact in-row offset after reordering', () => {
    const anchor = captureTaskHistoryAnchor(rows, 2 + 34 + 13)
    expect(anchor).toEqual({ rowKey: 'conversation:b', offsetWithinRow: 13 })
    expect(resolveTaskHistoryAnchorOffset([rows[2]!, rows[0]!, rows[1]!, rows[3]!], anchor, rows)).toBe(2 + 68 + 13)
  })

  it('uses a surviving neighbor when the anchored row is hidden or removed', () => {
    expect(resolveTaskHistoryAnchorOffset([rows[0]!, rows[3]!], { rowKey: 'conversation:c', offsetWithinRow: 12 }, rows)).toBe(36)
    expect(resolveTaskHistoryAnchorOffset(rows, { rowKey: 'missing', offsetWithinRow: 12 })).toBeNull()
  })

  it('requests only viewport-near scopes even with 100 expanded spaces', () => {
    const spaceRows: TaskHistoryRow[] = Array.from({ length: 100 }, (_, index) => ({ kind: 'space', key: `space:${index}`, space: space(String(index)) }))
    const near = resolveNearbyTaskHistoryScopes({ rows: spaceRows, scrollTop: 34 * 50, height: 34 * 10, isSpaceExpanded: () => true })
    expect(near).toEqual(expect.arrayContaining(Array.from({ length: 10 }, (_, index) => String(50 + index))))
    expect(near.every(id => id !== null && Number(id) >= 40 && Number(id) < 70)).toBe(true)
    expect(resolveNearbyTaskHistoryScopes({ rows: spaceRows, scrollTop: 0, height: 340, isSpaceExpanded: () => false })).toEqual([])
  })
})
