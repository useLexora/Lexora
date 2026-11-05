import type { DesktopTaskPinnedItem, DesktopTaskSidebarSection } from '@buddy-electron/shared/desktopApi'
import type { LocalConversationSummary } from '@buddy-shared/conversation/conversationApi'
import type { LocalTaskMarkState } from '@buddy-shared/conversation/taskMarkApi'
import type { LocalSpace } from '@buddy-shared/spaces/spaceApi'
import type { ShallowRef } from 'vue'
import type { TaskIndex } from '../../../contracts'
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
  history?: TaskIndex['history']
  onHistoryError?: () => void
  markStates?: ShallowRef<ReadonlyMap<string, LocalTaskMarkState>>
  tasks?: ShallowRef<readonly LocalConversationSummary[]>
  pins: ShallowRef<readonly DesktopTaskPinnedItem[]>
  sidebar: ReturnType<typeof createSidebarFixture>['sidebar']
  spaces: ShallowRef<readonly LocalSpace[]>
}) {
  const scope = effectScope()
  const history = input.history ?? historyFixture()
  scopes.push(scope)
  return scope.run(() => useTaskIndexController({
    activeConversationId: () => null,
    history: () => history,
    onHistoryError: input.onHistoryError ?? (() => {}),
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

function historyFixture(): TaskIndex['history'] {
  return {
    scopes: shallowRef(new Map()),
    anchors: shallowRef({ pinned: null, spaces: null, tasks: null }),
    recordAnchor() {},
    ensureScope: async () => {},
    loadMore: async () => {},
    setActiveTask: async () => {},
    search: async () => ({ items: [], nextCursor: null }),
  }
}

describe('task index presentation', () => {
  it('preserves loaded rows on page failure and retries only on explicit action', async () => {
    const pins = shallowRef<readonly DesktopTaskPinnedItem[]>([])
    const { sidebar } = createSidebarFixture([])
    const history = historyFixture()
    let attempts = 0
    let errorCount = 0
    history.ensureScope = async () => {
      attempts += 1
      if (attempts === 1)
        throw new Error('unavailable')
    }
    const controller = createController({
      pins,
      sidebar,
      history,
      spaces: shallowRef([space('a')]),
      tasks: shallowRef([{ id: 'attention', spaceId: 'a', updatedAt: '2026-09-08T00:00:00.000Z', activity: 'idle' } as LocalConversationSummary]),
      onHistoryError: () => errorCount += 1,
    })
    await controller.ensureHistoryScope('a')
    expect(controller.failedHistoryScopes.value.has('space:a')).toBe(true)
    expect(controller.spaceRows.value.map(row => row.key)).toEqual(['space:a', 'conversation:attention'])
    await controller.ensureHistoryScope('a')
    expect(errorCount).toBe(1)
    expect(attempts).toBe(1)
    expect(await controller.loadMoreHistory('a')).toBe(true)
    expect(controller.failedHistoryScopes.value.size).toBe(0)
    expect(attempts).toBe(2)
  })

  it('reveals a searched old task in its pinned, previously collapsed space', async () => {
    const pins = shallowRef<readonly DesktopTaskPinnedItem[]>([{ kind: 'space', id: 'a' }])
    const { sidebar } = createSidebarFixture([])
    await sidebar.setSpaceExpanded('a', false)
    await sidebar.setSectionExpanded('pinned', false)
    const history = historyFixture()
    const tasks = shallowRef<readonly LocalConversationSummary[]>([])
    const oldTask = { id: 'old', spaceId: 'a', updatedAt: '2020-01-01T00:00:00.000Z', activity: 'idle' } as LocalConversationSummary
    history.setActiveTask = async (id) => {
      if (id === oldTask.id)
        tasks.value = [oldTask]
    }
    const controller = createController({ pins, sidebar, history, spaces: shallowRef([space('a')]), tasks })
    expect(await controller.revealTask(oldTask)).toBe(true)
    expect(controller.isSpaceExpanded('a')).toBe(true)
    expect(controller.isSectionExpanded('pinned')).toBe(true)
    expect(controller.historyRows.value.some(row => row.key === 'conversation:old')).toBe(true)
    expect(controller.revealTarget.value).toEqual({ rowKey: 'conversation:old' })
  })

  it('keeps unloaded pins when pinning, unpinning and reordering visible entries', () => {
    const pins = shallowRef<readonly DesktopTaskPinnedItem[]>([
      { kind: 'conversation', id: 'unloaded' },
      { kind: 'space', id: 'a' },
      { kind: 'space', id: 'b' },
    ])
    const { sidebar } = createSidebarFixture([])
    const controller = createController({ pins, sidebar, spaces: shallowRef([space('a'), space('b'), space('c')]) })
    controller.pinSpace('c')
    expect(pins.value.map(item => item.id)).toEqual(['c', 'unloaded', 'a', 'b'])
    controller.pinTask('new-global')
    expect(pins.value.map(item => item.id)).toEqual(['new-global', 'c', 'unloaded', 'a', 'b'])
    controller.unpinItem('space:c')
    expect(pins.value.map(item => item.id)).toEqual(['new-global', 'unloaded', 'a', 'b'])
    controller.beginPinnedDrag('space:b')
    controller.dropPinnedItem('space:a', 'before')
    expect(pins.value.map(item => item.id)).toEqual(['new-global', 'unloaded', 'b', 'a'])
  })

  it('updates marked and unread ordering across scopes without reordering pins', () => {
    const pins = shallowRef<readonly DesktopTaskPinnedItem[]>([{ kind: 'space', id: 'b' }, { kind: 'conversation', id: 'global-pinned' }])
    const tasks = shallowRef<readonly LocalConversationSummary[]>([
      ['a-new', 'a'],
      ['a-marked', 'a'],
      ['a-unread', 'a'],
      ['b-new', 'b'],
      ['b-marked', 'b'],
      ['global-new', null],
      ['global-marked', null],
      ['global-pinned', null],
    ].map(([id, spaceId]) => ({ id, spaceId, activity: 'idle', updatedAt: '2026-09-08T00:00:00.000Z' } as LocalConversationSummary)))
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
    const controller = createController({ pins, sidebar, spaces: shallowRef([space('a'), space('b')]), tasks, markStates })
    expect(controller.spaceRows.value.map(row => row.key)).toEqual(['space:a', 'conversation:a-unread', 'conversation:a-new', 'conversation:a-marked'])
    expect(controller.pinnedRows.value.map(row => row.key)).toEqual(['space:b', 'conversation:b-new', 'conversation:b-marked', 'conversation:global-pinned'])

    markStates.value = new Map([
      [unread.conversationId, unread],
      ...['a-marked', 'b-marked', 'global-marked', 'global-pinned'].map(id => [id, state(id, 'custom')] as const),
    ])
    expect(controller.spaceRows.value.map(row => row.key)).toEqual(['space:a', 'conversation:a-marked', 'conversation:a-unread', 'conversation:a-new'])
    expect(controller.pinnedRows.value.map(row => row.key)).toEqual(['space:b', 'conversation:b-marked', 'conversation:b-new', 'conversation:global-pinned'])
    expect(controller.globalTasks.value.map(task => task.id)).toEqual(['global-marked', 'global-new'])

    markStates.value = new Map([[unread.conversationId, unread]])
    expect(controller.spaceRows.value.map(row => row.key)).toEqual(['space:a', 'conversation:a-unread', 'conversation:a-new', 'conversation:a-marked'])
    expect(controller.pinnedRows.value.map(row => row.key)).toEqual(['space:b', 'conversation:b-new', 'conversation:b-marked', 'conversation:global-pinned'])
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
})
