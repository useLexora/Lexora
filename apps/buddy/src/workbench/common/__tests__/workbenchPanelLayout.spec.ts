import { describe, expect, it } from 'vitest'
import { resolveDesktopWorkbenchPanelRange, resolveDesktopWorkbenchWidths } from '../workbenchPanelLayout'

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

  it('reserves the chat and resource minimum widths before shrinking history', () => {
    expect(resolveDesktopWorkbenchWidths({
      containerWidth: 760,
      contextVisible: true,
      preferredContextWidth: 400,
      preferredSidebarWidth: 320,
      sidebarVisible: true,
    })).toEqual({ contextWidth: 272, sidebarWidth: 200, workspaceWidth: 288 })
    expect(resolveDesktopWorkbenchPanelRange('context', {
      containerWidth: 1200,
      contextVisible: true,
      contextWidth: 400,
      sidebarWidth: 224,
      sidebarVisible: true,
    })).toEqual({ minimum: 272, maximum: 688 })
  })

  it('keeps history width and releases the context allocation while resources are maximized', () => {
    expect(resolveDesktopWorkbenchWidths({
      containerWidth: 760,
      contextVisible: false,
      preferredContextWidth: 400,
      preferredSidebarWidth: 320,
      sidebarVisible: true,
      workspaceMinimumWidth: 272,
    })).toEqual({ contextWidth: 0, sidebarWidth: 320, workspaceWidth: 440 })
  })
})
