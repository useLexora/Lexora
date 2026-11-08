import type { DesktopTaskPinnedItem, DesktopTaskSidebarSection } from '@buddy-electron/shared/desktopApi'
import type { LocalConversationSummary } from '@buddy-shared/conversation/conversationApi'
import type { LocalSpace } from '@buddy-shared/spaces/spaceApi'
import type { TaskActivity, TaskIndex } from '../../contracts'

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

export type TaskHistoryRow = TaskIndexRow | {
  key: string
  kind: 'section'
  section: DesktopTaskSidebarSection
} | {
  key: string
  kind: 'more'
  spaceId: string | null
  initialized: boolean
  loading: boolean
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
  unreadTaskIds: ReadonlySet<string>
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

  const compareTasks = (left: LocalConversationSummary, right: LocalConversationSummary) => (
    Number(input.markedTaskIds.has(right.id)) - Number(input.markedTaskIds.has(left.id))
    || Number(input.unreadTaskIds.has(right.id)) - Number(input.unreadTaskIds.has(left.id))
    || right.updatedAt.localeCompare(left.updatedAt)
  )
  globalTasks.sort(compareTasks)
  for (const tasks of tasksBySpace.values())
    tasks.sort(compareTasks)

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
          key: `conversation:${item.id}`,
          kind: 'task' as const,
          pinKey,
          pinnedTopLevel: true,
        }]
      }

      const space = spacesById.get(item.id)!
      const rows: TaskIndexRow[] = [{
        key: `space:${space.id}`,
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
        key: `conversation:${task.id}`,
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

export function getTaskHistoryScopeKey(spaceId: string | null): string {
  return spaceId === null ? 'global' : `space:${spaceId}`
}

export function resolveTaskHistoryRows(input: {
  projection: TaskIndexProjection
  collapsedSections: ReadonlySet<DesktopTaskSidebarSection>
  expandedSpaceIds: ReadonlySet<string>
  scopes: TaskIndex['history']['scopes']['value']
}): TaskHistoryRow[] {
  const rows: TaskHistoryRow[] = []
  const addMore = (spaceId: string | null) => {
    const scopeKey = getTaskHistoryScopeKey(spaceId)
    const scope = input.scopes.get(scopeKey)
    if (scope?.initialized && !scope.hasMore)
      return
    rows.push({
      key: `more:${scopeKey}`,
      kind: 'more',
      spaceId,
      initialized: scope?.initialized ?? false,
      loading: scope?.loading ?? false,
    })
  }
  const addSection = (section: DesktopTaskSidebarSection, items: TaskIndexRow[]) => {
    rows.push({ key: `section:${section}`, kind: 'section', section })
    if (input.collapsedSections.has(section))
      return
    let spaceId: string | null = null
    for (const row of items) {
      if (spaceId !== null && (row.kind === 'space' || !row.spaceTask)) {
        addMore(spaceId)
        spaceId = null
      }
      rows.push(row)
      if (row.kind === 'space' && input.expandedSpaceIds.has(row.space.id))
        spaceId = row.space.id
    }
    if (spaceId !== null)
      addMore(spaceId)
    if (section === 'tasks')
      addMore(null)
  }
  if (input.projection.pinnedRows.length)
    addSection('pinned', input.projection.pinnedRows)
  addSection('spaces', input.projection.spaceRows)
  addSection('tasks', input.projection.globalTasks.map(task => ({
    key: `conversation:${task.id}`,
    kind: 'task',
    task,
  })))
  return rows
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

const activityPriority: Record<TaskActivity, number> = { idle: 0, running: 1, awaiting_answer: 2, awaiting_approval: 3 }

export function resolveSpaceActivities(
  tasks: ReadonlyArray<LocalConversationSummary>,
  taskActivities: ReadonlyMap<string, TaskActivity> = new Map(),
): ReadonlyMap<string, TaskActivity> {
  const activities = new Map<string, TaskActivity>()
  for (const task of tasks) {
    const activity = taskActivities.get(task.id) ?? task.activity
    if (!task.spaceId || activity === 'idle')
      continue
    const current = activities.get(task.spaceId) ?? 'idle'
    if (activityPriority[activity] > activityPriority[current])
      activities.set(task.spaceId, activity)
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
    key: `conversation:${task.id}`,
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
