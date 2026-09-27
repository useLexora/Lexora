import { describe, expect, it } from 'vitest'
import {
  resolveDesktopWorkbenchContextResizeWidth,
  resolveDesktopWorkbenchWidths,
} from '../workbenchPanelLayout'

describe('workbench context panel resizing coordinates', () => {
  it('excludes the visible task sidebar when the context panel is on the left', () => {
    expect(resolveDesktopWorkbenchContextResizeWidth({
      clientX: 620,
      containerLeft: 100,
      containerRight: 1200,
      contextOnLeft: true,
      sidebarWidth: 240,
    })).toBe(280)
  })

  it('uses the full left edge when the task sidebar is collapsed', () => {
    expect(resolveDesktopWorkbenchContextResizeWidth({
      clientX: 380,
      containerLeft: 100,
      containerRight: 1200,
      contextOnLeft: true,
      sidebarWidth: 0,
    })).toBe(280)
  })

  it('preserves right-side context resizing coordinates', () => {
    expect(resolveDesktopWorkbenchContextResizeWidth({
      clientX: 900,
      containerLeft: 100,
      containerRight: 1200,
      contextOnLeft: false,
      sidebarWidth: 240,
    })).toBe(300)
  })
})

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
