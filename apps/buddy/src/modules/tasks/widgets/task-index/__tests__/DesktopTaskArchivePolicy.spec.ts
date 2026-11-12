// @vitest-environment jsdom
import type { ConversationArchivePolicy } from '@buddy-shared/conversation/conversationArchiveApi'
import type { TaskArchiveActions } from '../../../contracts'
import { deferred } from '@buddy-tests/deferred'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, shallowRef } from 'vue'
import DesktopTaskArchivePolicy from '../DesktopTaskArchivePolicy.vue'

vi.hoisted(() => {
  vi.stubGlobal('ResizeObserver', class {
    constructor(private callback: ResizeObserverCallback) {}
    observe(target: Element) {
      this.callback([{ target, contentRect: new DOMRect(0, 0, 400, 272) } as ResizeObserverEntry], this as unknown as ResizeObserver)
    }

    unobserve() {}
    disconnect() {}
  })
})
const cleanups: (() => void)[] = []
beforeEach(() => {
  vi.stubGlobal('matchMedia', (media: string) => ({ matches: false, media, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true }))
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value() {} })
})
afterEach(() => {
  cleanups.splice(0).forEach(cleanup => cleanup())
  document.body.innerHTML = ''
})
async function mount(initial: ConversationArchivePolicy['days'] = 0) {
  const ready = shallowRef(true)
  const getPolicy = vi.fn<TaskArchiveActions['getPolicy']>().mockResolvedValue({ days: initial })
  const setPolicy = vi.fn<TaskArchiveActions['setPolicy']>().mockImplementation(async days => ({ days }))
  const actions: TaskArchiveActions = { get: vi.fn(), onChanged: () => () => {}, ready, getPolicy, setPolicy, archive: vi.fn(), restore: vi.fn(), delete: vi.fn(), list: vi.fn() }
  const root = document.createElement('div')
  document.body.append(root)
  const app = createApp({ render: () => h(DesktopTaskArchivePolicy, { actions, language: 'zh-CN', disabled: false }) })
  app.mount(root)
  cleanups.push(() => app.unmount())
  await nextTick()
  await nextTick()
  async function select(label: string) {
    root.querySelector<HTMLElement>('.n-base-selection')!.click()
    await nextTick()
    const option = [...document.querySelectorAll<HTMLElement>('.n-base-select-option')].find(item => item.textContent?.trim() === label)!
    expect(option).toBeDefined()
    option.click()
    await nextTick()
  }
  function button(label: string) {
    return [...document.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent?.trim() === label)!
  }
  return { root, ready, getPolicy, setPolicy, select, button }
}

describe('archive cleanup policy', () => {
  it('defaults to no cleanup and requires explicit permanent-deletion consent to enable or shorten it', async () => {
    const f = await mount()
    expect(f.root.textContent).toContain('不清理')
    await f.select('7 天')
    expect(document.body.textContent).toContain('不可恢复')
    expect(document.body.textContent).toContain('已经到期的任务可能立即删除')
    expect(document.body.textContent).toContain('旧版已移除的任务不自动清理')
    expect(f.setPolicy).not.toHaveBeenCalled()
    f.button('取消').click()
    await nextTick()
    expect(f.root.textContent).toContain('不清理')
    await f.select('7 天')
    f.button('保存').click()
    await vi.waitFor(() => expect(f.setPolicy).toHaveBeenCalledWith(7))
    await f.select('3 天')
    expect(f.setPolicy.mock.calls).toEqual([[7]])
    f.button('取消').click()
    await nextTick()
    await f.select('30 天')
    await vi.waitFor(() => expect(f.setPolicy.mock.calls).toEqual([[7], [30]]))
    await f.select('不清理')
    await vi.waitFor(() => expect(f.setPolicy.mock.calls).toEqual([[7], [30], [0]]))
  })

  it('keeps the saved policy and exposes an associated field error when enabling cleanup fails', async () => {
    const f = await mount()
    const control = f.root.querySelector('[aria-labelledby]')!
    const label = document.getElementById(control.getAttribute('aria-labelledby')!)
    expect(label?.textContent).toBe('自动清理归档任务')
    f.setPolicy.mockRejectedValueOnce(new Error('policy save failed'))
    await f.select('7 天')
    f.button('保存').click()
    await vi.waitFor(() => expect(document.querySelector('[data-testid="task-archive-policy-confirm"] [role="alert"]')?.textContent).toContain('本地任务操作失败'))
    expect(f.root.querySelector('.n-base-selection')?.textContent).toContain('不清理')
    expect(document.querySelector('[data-testid="task-archive-policy-confirm"]')).not.toBeNull()
    f.button('取消').click()
    await nextTick()
    expect(f.setPolicy.mock.calls).toEqual([[7]])
    const error = f.root.querySelector('[role="alert"]')!
    expect(error.textContent).toContain('本地任务操作失败')
    expect(control.getAttribute('aria-describedby')?.split(' ')).toContain(error.id)
  })

  it('invalidates pending risk consent and stale reads when readiness changes', async () => {
    const f = await mount()
    await f.select('3 天')
    f.ready.value = false
    await nextTick()
    expect(f.setPolicy).not.toHaveBeenCalled()
    const late = deferred<ConversationArchivePolicy>()
    f.getPolicy.mockReturnValueOnce(late.promise)
    f.ready.value = true
    await nextTick()
    f.ready.value = false
    late.resolve({ days: 3 })
    await nextTick()
    f.getPolicy.mockResolvedValue({ days: 30 })
    f.ready.value = true
    await vi.waitFor(() => expect(f.root.textContent).toContain('30 天'))
    expect(f.setPolicy).not.toHaveBeenCalled()
  })
})
