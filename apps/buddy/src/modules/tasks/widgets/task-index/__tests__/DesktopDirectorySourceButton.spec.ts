// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick } from 'vue'
import DesktopDirectorySourceButton from '../DesktopDirectorySourceButton.vue'

const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).forEach(cleanup => cleanup()))

function mount(distributions: string[], onSelect = vi.fn()) {
  const host = document.createElement('div')
  document.body.append(host)
  const app = createApp({ render: () => h(DesktopDirectorySourceButton, { disabled: false, distributions, label: '选择目录', language: 'zh-CN', onSelect }) })
  app.mount(host)
  cleanups.push(() => {
    app.unmount()
    host.remove()
  })
  return { host, onSelect }
}

describe('directory source button', () => {
  it('is a single plain button when there is no WSL, as on macOS, Linux or Windows without it', async () => {
    const { host, onSelect } = mount([])
    await nextTick()
    const buttons = host.querySelectorAll('button')
    expect(buttons).toHaveLength(1)
    expect(buttons[0]!.textContent).toContain('选择目录')
    buttons[0]!.click()
    expect(onSelect).toHaveBeenCalledWith()
  })

  it('adds a source menu only when a distribution is installed', async () => {
    const { host, onSelect } = mount(['Ubuntu-24.04'])
    await nextTick()
    const buttons = host.querySelectorAll('button')
    expect(buttons).toHaveLength(2)
    expect(buttons[1]!.getAttribute('aria-label')).toBe('选择目录来源')
    buttons[0]!.click()
    expect(onSelect).toHaveBeenCalledWith()
  })
})
