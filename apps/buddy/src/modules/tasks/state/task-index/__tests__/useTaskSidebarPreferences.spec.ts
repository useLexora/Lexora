import type { DesktopTaskSidebarSection } from '@buddy-electron/shared/desktopApi'
import { lexoraConfigPatchSchema } from '@buddy-electron/shared/desktopApiSchemas'
import { describe, expect, it } from 'vitest'
import { shallowRef } from 'vue'
import { useTaskSidebarPreferences } from '../useTaskSidebarPreferences'

interface SidebarTaskSidebar {
  collapsed: boolean
  collapsedSections: DesktopTaskSidebarSection[]
  collapsedSpaces: string[]
  width: number | null
}

interface SidebarDesktopSettings {
  taskSidebar: SidebarTaskSidebar
}

interface SidebarDesktopPatch { taskSidebar: Partial<SidebarTaskSidebar> }

function createFixture(options: { failWrites?: boolean, initial?: SidebarDesktopPatch } = {}) {
  const desktop: SidebarDesktopSettings = {
    taskSidebar: {
      collapsed: false,
      collapsedSections: [],
      collapsedSpaces: [],
      width: null,
      ...options.initial?.taskSidebar,
    },
  }
  const config = shallowRef<{ desktop: SidebarDesktopSettings }>({ desktop })
  const writes: Array<SidebarDesktopPatch> = []
  const sidebar = useTaskSidebarPreferences({
    config,
    updateSettings: async (patch) => {
      lexoraConfigPatchSchema.parse(patch)
      if (options.failWrites)
        return false
      writes.push(patch.desktop)
      config.value = {
        desktop: {
          ...config.value.desktop,
          taskSidebar: { ...config.value.desktop.taskSidebar, ...patch.desktop.taskSidebar },
        },
      }
      return true
    },
  })
  return { config, sidebar, writes }
}

describe('task sidebar preferences', () => {
  it('persists only the changed preference with whole-pixel widths and keeps optimistic state', async () => {
    const { sidebar, writes } = createFixture()
    await sidebar.setSectionExpanded('pinned', false)
    await sidebar.setSpaceExpanded('space-a', false)
    await sidebar.setCollapsed(true)
    await sidebar.setWidth(336.42)

    expect(writes).toEqual([
      { taskSidebar: { collapsedSections: ['pinned'] } },
      { taskSidebar: { collapsedSpaces: ['space-a'] } },
      { taskSidebar: { collapsed: true } },
      { taskSidebar: { width: 336 } },
    ])
    expect(sidebar.isSectionExpanded('pinned')).toBe(false)
    expect(sidebar.isSpaceExpanded('space-a')).toBe(false)
    expect(sidebar.collapsed.value).toBe(true)
    expect(sidebar.width.value).toBe(336)
    await sidebar.setWidth(null)
    expect(sidebar.width.value).toBe(null)
  })

  it('rolls back the optimistic change when the profile write fails', async () => {
    const { sidebar } = createFixture({ failWrites: true })
    await expect(sidebar.setCollapsed(true)).resolves.toBe(false)
    expect(sidebar.collapsed.value).toBe(false)
    await expect(sidebar.setSpaceExpanded('space-a', false)).resolves.toBe(false)
    expect(sidebar.isSpaceExpanded('space-a')).toBe(true)
    await expect(sidebar.setWidth(263.42)).resolves.toBe(false)
    expect(sidebar.width.value).toBe(null)
  })

  it('drops folded Spaces that disappeared while keeping the preference before Spaces load', async () => {
    const { sidebar, writes } = createFixture({
      initial: { taskSidebar: { collapsedSpaces: ['space-a', 'space-b'] } },
    })
    sidebar.pruneSpaces(new Set())
    expect([...sidebar.collapsedSpaceIds.value]).toEqual(['space-a', 'space-b'])
    expect(writes).toHaveLength(0)

    sidebar.pruneSpaces(new Set(['space-a']))
    await Promise.resolve()
    expect([...sidebar.collapsedSpaceIds.value]).toEqual(['space-a'])
    expect(writes.at(-1)).toEqual({ taskSidebar: { collapsedSpaces: ['space-a'] } })
  })

  it('keeps the scroll anchor in memory without writing the profile', () => {
    const { sidebar, writes } = createFixture()
    sidebar.recordScrollAnchor('tasks', 7)
    expect(sidebar.scrollAnchors.value).toEqual({ pinned: 0, spaces: 0, tasks: 7 })
    expect(writes).toHaveLength(0)
  })
})
