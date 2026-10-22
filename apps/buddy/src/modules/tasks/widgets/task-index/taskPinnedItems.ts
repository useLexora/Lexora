import type { DesktopTaskPinnedItem } from '@buddy-electron/shared/desktopApi'
import type { LocalConversationSummary } from '@buddy-shared/conversation/conversationApi'
import type { LocalSpace } from '@buddy-shared/spaces/spaceApi'

export type TaskIndexRow
  = | {
    key: string
    kind: 'space'
    pinKey?: string
    pinnedTopLevel?: boolean
    space: LocalSpace
  }
  | {
    task: LocalConversationSummary
    key: string
    kind: 'task'
    pinKey?: string
    pinnedTopLevel?: boolean
    spaceTask?: boolean
  }

export interface TaskIndexProjection {
  pinnedItems: DesktopTaskPinnedItem[]
  pinnedRows: TaskIndexRow[]
  spaceRows: TaskIndexRow[]
  globalTasks: LocalConversationSummary[]
}

export type DesktopTaskPinnedDropPosition = 'after' | 'before'

export function resolveTaskIndexProjection(input: {
  expandedSpaceIds: ReadonlySet<string>
  markedTaskIds: ReadonlySet<string>
  pinnedItems: ReadonlyArray<DesktopTaskPinnedItem>
  spaces: ReadonlyArray<LocalSpace>
  tasks: ReadonlyArray<LocalConversationSummary>
}): TaskIndexProjection {
  const activeSpaces = input.spaces.filter(space => space.revokedAt === null)
  const spacesById = new Map(activeSpaces.map(space => [space.id, space]))
  const globalTasks = input.tasks.filter(task => task.spaceId === null)
  const globalTasksById = new Map(globalTasks.map(task => [task.id, task]))
  const tasksBySpace = new Map<string, LocalConversationSummary[]>()

  for (const task of input.tasks) {
    if (!task.spaceId)
      continue
    const tasks = tasksBySpace.get(task.spaceId) ?? []
    tasks.push(task)
    tasksBySpace.set(task.spaceId, tasks)
  }

  for (const tasks of tasksBySpace.values()) {
    tasks.sort((left, right) => Number(input.markedTaskIds.has(right.id)) - Number(input.markedTaskIds.has(left.id)))
  }

  const pinnedItems = resolveVisiblePinnedItems({
    items: input.pinnedItems,
    spacesById,
    tasksById: globalTasksById,
  })
  const pinnedSpaceIds = new Set(pinnedItems
    .filter(item => item.kind === 'space')
    .map(item => item.id))
  const pinnedConversationIds = new Set(pinnedItems
    .filter(item => item.kind === 'conversation')
    .map(item => item.id))

  return {
    pinnedItems,
    pinnedRows: pinnedItems.flatMap((item) => {
      const pinKey = getDesktopTaskPinnedItemKey(item)
      if (item.kind === 'conversation') {
        return [{
          task: globalTasksById.get(item.id)!,
          key: `pinned:${pinKey}`,
          kind: 'task' as const,
          pinKey,
          pinnedTopLevel: true,
        }]
      }

      const space = spacesById.get(item.id)!
      const rows: TaskIndexRow[] = [{
        key: `pinned:${pinKey}`,
        kind: 'space',
        pinKey,
        pinnedTopLevel: true,
        space,
      }]
      if (!input.expandedSpaceIds.has(space.id))
        return rows
      const spaceTasks = tasksBySpace.get(space.id) ?? []
      return rows.concat(spaceTasks.map(task => ({
        task,
        key: `pinned:${pinKey}:conversation:${task.id}`,
        kind: 'task' as const,
        pinKey,
        spaceTask: true,
      })))
    }),
    spaceRows: activeSpaces
      .filter(space => !pinnedSpaceIds.has(space.id))
      .flatMap(space => createSpaceRows(
        space,
        tasksBySpace.get(space.id) ?? [],
        input.expandedSpaceIds.has(space.id),
      )),
    globalTasks: globalTasks.filter(task => !pinnedConversationIds.has(task.id)),
  }
}

export function prependDesktopTaskPinnedItem(
  items: ReadonlyArray<DesktopTaskPinnedItem>,
  item: DesktopTaskPinnedItem,
): DesktopTaskPinnedItem[] {
  const key = getDesktopTaskPinnedItemKey(item)
  return items.some(candidate => getDesktopTaskPinnedItemKey(candidate) === key)
    ? [...items]
    : [item, ...items]
}

export function removeDesktopTaskPinnedItem(
  items: ReadonlyArray<DesktopTaskPinnedItem>,
  key: string,
): DesktopTaskPinnedItem[] {
  return items.filter(item => getDesktopTaskPinnedItemKey(item) !== key)
}

export function reorderDesktopTaskPinnedItems(
  items: ReadonlyArray<DesktopTaskPinnedItem>,
  sourceKey: string,
  targetKey: string,
  position: DesktopTaskPinnedDropPosition,
): DesktopTaskPinnedItem[] {
  const sourceIndex = items.findIndex(item => getDesktopTaskPinnedItemKey(item) === sourceKey)
  const targetIndex = items.findIndex(item => getDesktopTaskPinnedItemKey(item) === targetKey)
  if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex)
    return [...items]

  const next = [...items]
  const [source] = next.splice(sourceIndex, 1)
  const nextTargetIndex = next.findIndex(item => getDesktopTaskPinnedItemKey(item) === targetKey)
  if (nextTargetIndex < 0)
    return [...items]
  next.splice(position === 'after' ? nextTargetIndex + 1 : nextTargetIndex, 0, source)
  return next
}

export function getDesktopTaskPinnedItemKey(item: DesktopTaskPinnedItem): string {
  return `${item.kind}:${item.id}`
}

export function resolveSpaceActivities(
  tasks: ReadonlyArray<LocalConversationSummary>,
): ReadonlyMap<string, LocalConversationSummary['activity']> {
  const activities = new Map<string, LocalConversationSummary['activity']>()
  for (const task of tasks) {
    if (!task.spaceId || task.activity === 'idle')
      continue
    const current = activities.get(task.spaceId)
    // Waiting for approval needs the user, so it outranks running.
    if (current === 'awaiting_approval')
      continue
    if (current === undefined || task.activity === 'awaiting_approval')
      activities.set(task.spaceId, task.activity)
  }
  return activities
}

function createSpaceRows(
  space: LocalSpace,
  tasks: ReadonlyArray<LocalConversationSummary>,
  expanded: boolean,
): TaskIndexRow[] {
  const rows: TaskIndexRow[] = [{
    key: `space:${space.id}`,
    kind: 'space',
    space,
  }]
  if (!expanded)
    return rows
  return rows.concat(tasks.map(task => ({
    task,
    key: `space:${space.id}:conversation:${task.id}`,
    kind: 'task' as const,
    spaceTask: true,
  })))
}

function resolveVisiblePinnedItems(input: {
  items: ReadonlyArray<DesktopTaskPinnedItem>
  spacesById: ReadonlyMap<string, LocalSpace>
  tasksById: ReadonlyMap<string, LocalConversationSummary>
}): DesktopTaskPinnedItem[] {
  const keys = new Set<string>()
  return input.items.filter((item) => {
    const key = getDesktopTaskPinnedItemKey(item)
    if (keys.has(key))
      return false
    const exists = item.kind === 'space'
      ? input.spacesById.has(item.id)
      : input.tasksById.has(item.id)
    if (exists)
      keys.add(key)
    return exists
  })
}
