// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, shallowRef } from 'vue'
import { useWorkbenchSidebarToggle } from '../useWorkbenchSidebarToggle'

afterEach(() => vi.useRealTimers())

describe('sidebar toggle lifecycle', () => {
  it.each([false, true])('does not change the saved fold state after unmount, frame scheduled: %s', async (scheduleFrame) => {
    vi.useFakeTimers()
    const collapsed = shallowRef(false)
    const root = document.createElement('div')
    let controls!: ReturnType<typeof useWorkbenchSidebarToggle>
    const app = createApp({
      setup() {
        controls = useWorkbenchSidebarToggle({ container: shallowRef(root), sidebar: shallowRef(root), collapsed })
        return () => h('div')
      },
    })
    app.mount(root)
    const toggling = controls.toggleSidebar()
    if (scheduleFrame)
      await nextTick()
    app.unmount()
    await toggling
    await vi.runAllTimersAsync()
    expect(collapsed.value).toBe(false)
  })
})
