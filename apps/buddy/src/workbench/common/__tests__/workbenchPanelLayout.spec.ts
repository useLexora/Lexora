import { describe, expect, it } from 'vitest'
import { resolveDesktopWorkbenchWidths } from '../workbenchPanelLayout'

describe('nested workbench width allocation', () => {
  it('keeps a hidden sidebar at zero when the outer layout cannot meet its workspace minimum', () => {
    expect(resolveDesktopWorkbenchWidths({
      containerWidth: 620,
      contextVisible: true,
      preferredContextWidth: 400,
      preferredSidebarWidth: 224,
      sidebarVisible: false,
      workspaceMinimumWidth: 480,
    })).toEqual({ contextWidth: 272, sidebarWidth: 0, workspaceWidth: 348 })
  })
})
