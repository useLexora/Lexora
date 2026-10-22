import type { DesktopTaskPinnedItem, DesktopTaskSidebarSection } from '@buddy-electron/shared/desktopApi'
import type { LocalConversationSummary } from '@buddy-shared/conversation/conversationApi'
import type { LocalTaskMarkState } from '@buddy-shared/conversation/taskMarkApi'
import type { LocalSpace } from '@buddy-shared/spaces/spaceApi'
import type { ShallowRef } from 'vue'
import type { TaskIndexRow } from '../taskPinnedItems'
import { afterEach, describe, expect, it } from 'vitest'
import { effectScope, nextTick, shallowRef } from 'vue'
import { useTaskSidebarPreferences } from '@/modules/tasks/state/task-index/useTaskSidebarPreferences'
import { useTaskIndexController } from '../useTaskIndexController'

const scopes: ReturnType<typeof effectScope>[] = []
afterEach(() => scopes.splice(0).forEach(scope => scope.stop()))

function space(id: string): LocalSpace {
  return { id, name: id, icon: 'folder', iconColor: 'default', activeRunCount: 0, additionalDirectories: [], createdAt: '2026-09-08T00:00:00.000Z', memoryScope: 'space_only', primaryDirectory: null, revokedAt: null, updatedAt: '2026-09-08T00:00:00.000Z' }
}

async function flushWrites() {
  await nextTick()
  await new Promise(resolve => setTimeout(resolve, 0))
}

interface SidebarFixture {
  desktop: {
    taskSidebar: {
      collapsed: boolean
      collapsedSections: DesktopTaskSidebarSection[]
      collapsedSpaces: string[]
      width: number | null
    }
  }
}

function createSidebarFixture(writes: SidebarFixture['desktop'][]) {
  const config = shallowRef<{ desktop: SidebarFixture['desktop'] }>({
    desktop: {
      taskSidebar: {
        collapsed: false,
        collapsedSections: [],
        collapsedSpaces: [],
        width: null,
      },
    },
  })
  const sidebar = useTaskSidebarPreferences({
    config,
    updateSettings: async (patch) => {
      const next = {
        ...config.value.desktop,
        taskSidebar: { ...config.value.desktop.taskSidebar, ...patch.desktop.taskSidebar },
      }
      writes.push(next)
      config.value = { desktop: next }
      return true
    },
  })
  return { config, sidebar, writes }
}

function createController(input: {
  markStates?: ShallowRef<ReadonlyMap<string, LocalTaskMarkState>>
  tasks?: ShallowRef<readonly LocalConversationSummary[]>
  pins: ShallowRef<readonly DesktopTaskPinnedItem[]>
  sidebar: ReturnType<typeof createSidebarFixture>['sidebar']
  spaces: ShallowRef<readonly LocalSpace[]>
}) {
  const scope = effectScope()
  scopes.push(scope)
  return scope.run(() => useTaskIndexController({
    getUntitledLabel: () => 'Untitled',
    markStates: () => input.markStates?.value ?? new Map(),
    onCreateSpace: async () => true,
    onDeleteTask() {},
    onDeleteSpace() {},
    onNewTask() {},
    onOpenSpaceDirectory() {},
    onRenameTask() {},
    onUpdatePinnedItems: (items) => { input.pins.value = items },
    onUpdateSpace: async () => true,
    pinnedItems: input.pins,
    sidebar: () => input.sidebar,
    spaces: input.spaces,
    tasks: input.tasks ?? shallowRef([]),
  }))!
}

describe('task index presentation', () => {
  it.each([false, true])('prioritizes custom marks only within each Space and restores order when cleared (pinned: %s)', (pinned) => {
    const spaces = shallowRef<readonly LocalSpace[]>([space('a'), space('b')])
    const pins = shallowRef<readonly DesktopTaskPinnedItem[]>([
      ...(pinned ? [{ kind: 'space' as const, id: 'b' }, { kind: 'space' as const, id: 'a' }] : []),
      { kind: 'conversation', id: 'global-pinned' },
    ])
    const originalPins = [...pins.value]
    const originalTasks = [
      ['a-new', 'a'],
      ['a-marked-new', 'a'],
      ['a-unread', 'a'],
      ['a-marked-old', 'a'],
      ['a-old', 'a'],
      ['b-new', 'b'],
      ['b-marked', 'b'],
      ['global-new', null],
      ['global-marked', null],
      ['global-pinned', null],
    ].map(([id, spaceId]) => ({
      id,
      spaceId,
      title: id,
      activity: 'idle',
      updatedAt: '2026-09-08T00:00:00.000Z',
    } as LocalConversationSummary))
    const tasks = shallowRef<readonly LocalConversationSummary[]>(originalTasks)
    const state = (conversationId: string, markId: string | null = null, unread = false): LocalTaskMarkState => ({
      conversationId,
      markId,
      unread,
      resultRunId: null,
      readRevision: 0,
    })
    const unread = state('a-unread', null, true)
    const markStates = shallowRef<ReadonlyMap<string, LocalTaskMarkState>>(new Map([[unread.conversationId, unread]]))
    const { sidebar } = createSidebarFixture([])
    const controller = createController({ pins, sidebar, spaces, tasks, markStates })
    const rowIds = (rows: readonly TaskIndexRow[]) => rows.map(row => row.kind === 'space' ? row.space.id : row.task.id)
    const spaceRows = () => rowIds(pinned ? controller.pinnedRows.value : controller.spaceRows.value)
    const expectedRows = (aTasks: string[], bTasks: string[]) => pinned
      ? ['b', ...bTasks, 'a', ...aTasks, 'global-pinned']
      : ['a', ...aTasks, 'b', ...bTasks]
    const originalATasks = ['a-new', 'a-marked-new', 'a-unread', 'a-marked-old', 'a-old']
    const originalBTasks = ['b-new', 'b-marked']
    expect(spaceRows()).toEqual(expectedRows(originalATasks, originalBTasks))

    markStates.value = new Map([
      [unread.conversationId, unread],
      ...['a-marked-new', 'a-marked-old', 'b-marked', 'global-marked', 'global-pinned']
        .map(id => [id, state(id, 'custom')] as const),
    ])
    expect(spaceRows()).toEqual(expectedRows(
      ['a-marked-new', 'a-marked-old', 'a-new', 'a-unread', 'a-old'],
      ['b-marked', 'b-new'],
    ))
    expect(controller.globalTasks.value.map(task => task.id)).toEqual(['global-new', 'global-marked'])
    expect(controller.pinnedItems.value).toEqual(originalPins)
    expect(tasks.value.map(task => task.id)).toEqual(originalTasks.map(task => task.id))
    if (!pinned)
      expect(rowIds(controller.pinnedRows.value)).toEqual(['global-pinned'])

    markStates.value = new Map([
      [unread.conversationId, unread],
      ['a-marked-old', state('a-marked-old', null, true)],
    ])
    expect(spaceRows()).toEqual(expectedRows(originalATasks, originalBTasks))
  })

  it('keeps folded Spaces and pinned order across refresh while expanding newly introduced Spaces', async () => {
    const spaces = shallowRef<readonly LocalSpace[]>([space('a'), space('b')])
    const pins = shallowRef<readonly DesktopTaskPinnedItem[]>([{ kind: 'space', id: 'b' }, { kind: 'space', id: 'a' }])
    const { sidebar, writes } = createSidebarFixture([])
    const controller = createController({ pins, sidebar, spaces })

    controller.selectSpaceMenuAction(spaces.value[0]!, 'edit')
    controller.toggleSpace('a')
    await flushWrites()
    spaces.value = [{ ...space('a'), activeRunCount: 1 }, space('b'), space('c')]
    await nextTick()
    expect(controller.spaceEditTarget.value?.activeRunCount).toBe(1)
    expect(controller.isSpaceExpanded('a')).toBe(false)
    expect(controller.isSpaceExpanded('b')).toBe(true)
    expect(controller.isSpaceExpanded('c')).toBe(true)
    expect(controller.pinnedItems.value.map(item => item.id)).toEqual(['b', 'a'])
    expect(writes.at(-1)?.taskSidebar.collapsedSpaces).toEqual(['a'])
    spaces.value = [space('b'), space('c')]
    await nextTick()
    await flushWrites()
    expect(controller.pinnedItems.value.map(item => item.id)).toEqual(['b'])
    expect(controller.spaceDialogOpen.value).toBe(false)
    expect([...sidebar.collapsedSpaceIds.value]).toEqual([])
  })

  it('restores folded Spaces onto a rebuilt sidebar from persisted preferences', async () => {
    const spaces = shallowRef<readonly LocalSpace[]>([space('a'), space('b')])
    const pins = shallowRef<readonly DesktopTaskPinnedItem[]>([])
    const { sidebar, writes } = createSidebarFixture([])
    const first = createController({ pins, sidebar, spaces })
    first.toggleSpace('a')
    first.setSectionExpanded('tasks', false)
    first.recordScrollAnchor('tasks', 12)
    await flushWrites()
    scopes.splice(0).forEach(scope => scope.stop())

    const rebuilt = createController({ pins, sidebar, spaces })
    await flushWrites()
    expect(writes.at(-1)?.taskSidebar.collapsedSpaces).toEqual(['a'])
    expect(rebuilt.isSpaceExpanded('a')).toBe(false)
    expect(rebuilt.isSpaceExpanded('b')).toBe(true)
    expect(rebuilt.isSectionExpanded('tasks')).toBe(false)
    expect(rebuilt.isSectionExpanded('spaces')).toBe(true)
    expect(rebuilt.scrollAnchors.value.tasks).toBe(12)
  })
})
