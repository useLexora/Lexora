export type DesktopWorkbenchResizablePanel = 'context' | 'sidebar'

export interface DesktopWorkbenchPreferredWidths {
  workspaceMinimumWidth?: number
  containerWidth: number
  contextVisible: boolean
  preferredContextWidth: number
  preferredSidebarWidth: number
  sidebarVisible: boolean
}

export interface DesktopWorkbenchPanelWidths {
  contextWidth: number
  sidebarWidth: number
  workspaceWidth: number
}

export interface DesktopWorkbenchPanelRangeInput {
  workspaceMinimumWidth?: number
  containerWidth: number
  contextVisible: boolean
  contextWidth: number
  sidebarWidth: number
  sidebarVisible: boolean
}

export interface DesktopWorkbenchPanelRange {
  maximum: number
  minimum: number
}

export const DESKTOP_WORKBENCH_WIDTH_LIMITS = {
  context: {
    minimum: 272,
  },
  sidebar: {
    maximum: 384,
    minimum: 192,
  },
  workspace: {
    minimum: 288,
  },
} as const

export function resolveDesktopWorkbenchWidths(
  input: DesktopWorkbenchPreferredWidths,
): DesktopWorkbenchPanelWidths {
  let sidebarWidth = input.sidebarVisible
    ? clamp(
        input.preferredSidebarWidth,
        DESKTOP_WORKBENCH_WIDTH_LIMITS.sidebar.minimum,
        DESKTOP_WORKBENCH_WIDTH_LIMITS.sidebar.maximum,
      )
    : 0
  let contextWidth = input.contextVisible
    ? Math.max(
        input.preferredContextWidth,
        DESKTOP_WORKBENCH_WIDTH_LIMITS.context.minimum,
      )
    : 0
  let overflow = Math.max(
    0,
    sidebarWidth
    + contextWidth
    - Math.max(0, input.containerWidth - (input.workspaceMinimumWidth ?? DESKTOP_WORKBENCH_WIDTH_LIMITS.workspace.minimum)),
  )

  if (input.contextVisible && overflow > 0) {
    const contextReduction = Math.min(
      overflow,
      contextWidth - DESKTOP_WORKBENCH_WIDTH_LIMITS.context.minimum,
    )
    contextWidth -= contextReduction
    overflow -= contextReduction
  }

  if (input.sidebarVisible && overflow > 0) {
    const sidebarReduction = Math.min(
      overflow,
      sidebarWidth - DESKTOP_WORKBENCH_WIDTH_LIMITS.sidebar.minimum,
    )
    sidebarWidth -= sidebarReduction
  }

  return {
    contextWidth,
    sidebarWidth,
    workspaceWidth: Math.max(0, input.containerWidth - sidebarWidth - contextWidth),
  }
}

export function resolveDesktopWorkbenchPanelRange(
  panel: DesktopWorkbenchResizablePanel,
  input: DesktopWorkbenchPanelRangeInput,
): DesktopWorkbenchPanelRange {
  const minimum = DESKTOP_WORKBENCH_WIDTH_LIMITS[panel].minimum
  const otherPanelWidth = panel === 'sidebar' && input.contextVisible
    ? input.contextWidth
    : panel === 'context' && input.sidebarVisible
      ? input.sidebarWidth
      : 0
  const availableWidth = input.containerWidth
    - (input.workspaceMinimumWidth ?? DESKTOP_WORKBENCH_WIDTH_LIMITS.workspace.minimum)
    - otherPanelWidth
  const maximum = panel === 'sidebar'
    ? Math.min(DESKTOP_WORKBENCH_WIDTH_LIMITS.sidebar.maximum, availableWidth)
    : availableWidth

  return {
    maximum: Math.max(minimum, maximum),
    minimum,
  }
}

export function clampDesktopWorkbenchPanelWidth(
  width: number,
  range: DesktopWorkbenchPanelRange,
): number {
  return clamp(width, range.minimum, range.maximum)
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}
