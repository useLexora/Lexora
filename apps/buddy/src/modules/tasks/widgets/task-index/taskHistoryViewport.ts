import type { TaskHistoryAnchor } from '../../contracts'
import type { TaskHistoryRow } from './taskPinnedItems'
import { DESKTOP_TASK_SIDEBAR_LIST_PADDING_TOP, DESKTOP_TASK_SIDEBAR_ROW_SIZE } from './taskSidebarLayout'

export type { TaskHistoryAnchor } from '../../contracts'

export function captureTaskHistoryAnchor(rows: readonly TaskHistoryRow[], scrollTop: number): TaskHistoryAnchor | null {
  const offset = Math.max(0, scrollTop - DESKTOP_TASK_SIDEBAR_LIST_PADDING_TOP)
  const index = Math.min(rows.length - 1, Math.floor(offset / DESKTOP_TASK_SIDEBAR_ROW_SIZE))
  const row = rows[index]
  return row
    ? {
        rowKey: row.key,
        offsetWithinRow: offset - index * DESKTOP_TASK_SIDEBAR_ROW_SIZE,
      }
    : null
}

export function resolveTaskHistoryAnchorOffset(
  rows: readonly TaskHistoryRow[],
  anchor: TaskHistoryAnchor | null,
  previousRows: readonly TaskHistoryRow[] = [],
): number | null {
  if (!anchor)
    return null
  const index = rows.findIndex(row => row.key === anchor.rowKey)
  if (index >= 0)
    return DESKTOP_TASK_SIDEBAR_LIST_PADDING_TOP + index * DESKTOP_TASK_SIDEBAR_ROW_SIZE + Math.max(0, Math.min(DESKTOP_TASK_SIDEBAR_ROW_SIZE - 1, anchor.offsetWithinRow))
  const oldIndex = previousRows.findIndex(row => row.key === anchor.rowKey)
  const indices = new Map(rows.map((row, rowIndex) => [row.key, rowIndex]))
  for (let distance = 1; distance < previousRows.length; distance += 1) {
    for (const candidate of [previousRows[oldIndex - distance], previousRows[oldIndex + distance]]) {
      const nextIndex = candidate ? indices.get(candidate.key) : undefined
      if (nextIndex !== undefined)
        return DESKTOP_TASK_SIDEBAR_LIST_PADDING_TOP + nextIndex * DESKTOP_TASK_SIDEBAR_ROW_SIZE
    }
  }
  return null
}

export function resolveNearbyTaskHistoryScopes(input: {
  rows: readonly TaskHistoryRow[]
  scrollTop: number
  height: number
  isSpaceExpanded: (spaceId: string) => boolean
}): (string | null)[] {
  const first = Math.max(0, Math.floor(input.scrollTop / DESKTOP_TASK_SIDEBAR_ROW_SIZE) - 3)
  const last = Math.min(input.rows.length, Math.ceil((input.scrollTop + input.height) / DESKTOP_TASK_SIDEBAR_ROW_SIZE) + 3)
  const scopes = new Set<string | null>()
  for (let index = first; index < last; index += 1) {
    const row = input.rows[index]!
    if (row.kind === 'more')
      scopes.add(row.spaceId)
    else if (row.kind === 'space' && input.isSpaceExpanded(row.space.id))
      scopes.add(row.space.id)
    else if (row.kind === 'task' && !row.pinnedTopLevel)
      scopes.add(row.task.spaceId)
  }
  return [...scopes]
}

export function getTaskHistoryRowScope(row: TaskHistoryRow): string | null | undefined {
  if (row.kind === 'space')
    return row.space.id
  if (row.kind === 'task')
    return row.task.spaceId
  if (row.kind === 'more')
    return row.spaceId
  return undefined
}
