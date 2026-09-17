import type { DesktopTaskSidebarSection } from '@buddy-electron/shared/desktopApi'
import type { Ref } from 'vue'
import { computed, readonly, shallowRef, watch } from 'vue'

interface TaskSidebarPreferencesConfig {
  desktop: {
    taskSidebar: {
      collapsed: boolean
      collapsedSections: readonly DesktopTaskSidebarSection[]
      collapsedSpaces: readonly string[]
      width: number | null
    }
  }
}

interface TaskSidebarPreferencesPatch {
  desktop: {
    taskSidebar: {
      collapsed?: boolean
      collapsedSections?: DesktopTaskSidebarSection[]
      collapsedSpaces?: string[]
      width?: number | null
    }
  }
}

interface TaskSidebarPreferencesSettings {
  config: Readonly<Ref<TaskSidebarPreferencesConfig | null>>
  updateSettings: (patch: TaskSidebarPreferencesPatch) => Promise<boolean>
}

export interface TaskSidebarPreferences {
  collapsed: Readonly<Ref<boolean>>
  collapsedSections: Readonly<Ref<ReadonlySet<DesktopTaskSidebarSection>>>
  collapsedSpaceIds: Readonly<Ref<ReadonlySet<string>>>
  scrollAnchors: Readonly<Ref<Readonly<Record<DesktopTaskSidebarSection, number>>>>
  width: Readonly<Ref<number | null>>
  isSectionExpanded: (section: DesktopTaskSidebarSection) => boolean
  isSpaceExpanded: (spaceId: string) => boolean
  pruneSpaces: (validSpaceIds: ReadonlySet<string>) => void
  recordScrollAnchor: (section: DesktopTaskSidebarSection, index: number) => void
  setCollapsed: (collapsed: boolean) => Promise<boolean>
  setSectionExpanded: (section: DesktopTaskSidebarSection, expanded: boolean) => Promise<boolean>
  setSpaceExpanded: (spaceId: string, expanded: boolean) => Promise<boolean>
  setWidth: (width: number | null) => Promise<boolean>
}

export function useTaskSidebarPreferences(
  settings: TaskSidebarPreferencesSettings,
): TaskSidebarPreferences {
  const persisted = computed(() => ({
    collapsed: settings.config.value?.desktop.taskSidebar.collapsed ?? false,
    collapsedSections: settings.config.value?.desktop.taskSidebar.collapsedSections ?? [],
    collapsedSpaces: settings.config.value?.desktop.taskSidebar.collapsedSpaces ?? [],
    width: settings.config.value?.desktop.taskSidebar.width ?? null,
  }))
  const collapsedSections = shallowRef<ReadonlySet<DesktopTaskSidebarSection>>(new Set())
  const collapsedSpaceIds = shallowRef<ReadonlySet<string>>(new Set())
  const collapsed = shallowRef(false)
  const width = shallowRef<number | null>(null)
  const scrollAnchors = shallowRef<Readonly<Record<DesktopTaskSidebarSection, number>>>(
    emptyScrollAnchors(),
  )
  let pendingWrites = 0
  let writeQueue: Promise<unknown> = Promise.resolve()

  watch(persisted, applyPersisted, { immediate: true })

  function applyPersisted(value: typeof persisted.value): void {
    collapsedSections.value = new Set(value.collapsedSections)
    collapsedSpaceIds.value = new Set(value.collapsedSpaces)
    collapsed.value = value.collapsed
    width.value = value.width
  }

  function commit(patch: TaskSidebarPreferencesPatch, optimistic: () => void): Promise<boolean> {
    optimistic()
    pendingWrites += 1
    const settle = () => {
      pendingWrites -= 1
      if (pendingWrites === 0)
        applyPersisted(persisted.value)
    }
    const update = writeQueue.then(() => settings.updateSettings(patch))
    const result = update.then(
      (saved) => {
        settle()
        return saved
      },
      (error) => {
        settle()
        throw error
      },
    )
    writeQueue = result.then(() => undefined, () => undefined)
    return result
  }

  function isSectionExpanded(section: DesktopTaskSidebarSection): boolean {
    return !collapsedSections.value.has(section)
  }

  function isSpaceExpanded(spaceId: string): boolean {
    return !collapsedSpaceIds.value.has(spaceId)
  }

  function setSectionExpanded(
    section: DesktopTaskSidebarSection,
    expanded: boolean,
  ): Promise<boolean> {
    const next = new Set(collapsedSections.value)
    if (expanded)
      next.delete(section)
    else
      next.add(section)
    return commit(
      { desktop: { taskSidebar: { collapsedSections: [...next] } } },
      () => collapsedSections.value = next,
    )
  }

  function setSpaceExpanded(spaceId: string, expanded: boolean): Promise<boolean> {
    const next = new Set(collapsedSpaceIds.value)
    if (expanded)
      next.delete(spaceId)
    else
      next.add(spaceId)
    return commit(
      { desktop: { taskSidebar: { collapsedSpaces: [...next] } } },
      () => collapsedSpaceIds.value = next,
    )
  }

  function setCollapsed(value: boolean): Promise<boolean> {
    return commit(
      { desktop: { taskSidebar: { collapsed: value } } },
      () => collapsed.value = value,
    )
  }

  function setWidth(value: number | null): Promise<boolean> {
    return commit({ desktop: { taskSidebar: { width: value } } }, () => width.value = value)
  }

  function pruneSpaces(validSpaceIds: ReadonlySet<string>): void {
    if (validSpaceIds.size === 0 || collapsedSpaceIds.value.size === 0)
      return
    const next = new Set([...collapsedSpaceIds.value].filter(id => validSpaceIds.has(id)))
    if (next.size === collapsedSpaceIds.value.size)
      return
    void commit(
      { desktop: { taskSidebar: { collapsedSpaces: [...next] } } },
      () => collapsedSpaceIds.value = next,
    )
  }

  function recordScrollAnchor(section: DesktopTaskSidebarSection, index: number): void {
    const current = scrollAnchors.value[section]
    if (current === index)
      return
    scrollAnchors.value = { ...scrollAnchors.value, [section]: index }
  }

  return {
    collapsed: readonly(collapsed),
    collapsedSections: readonly(collapsedSections),
    collapsedSpaceIds: readonly(collapsedSpaceIds),
    isSectionExpanded,
    isSpaceExpanded,
    pruneSpaces,
    recordScrollAnchor,
    scrollAnchors: readonly(scrollAnchors),
    setCollapsed,
    setSectionExpanded,
    setSpaceExpanded,
    setWidth,
    width: readonly(width),
  }
}

function emptyScrollAnchors(): Record<DesktopTaskSidebarSection, number> {
  return { pinned: 0, spaces: 0, tasks: 0 }
}
