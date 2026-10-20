// @vitest-environment jsdom
import type { LocalChangeRecoveryItem } from '@buddy-shared/changes/changeApi'
import type { TaskChangeRecovery } from '../../../contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, shallowRef } from 'vue'
import DesktopChangeRecoveryNotice from '../DesktopChangeRecoveryNotice.vue'

const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).forEach(cleanup => cleanup()))

function item(id: string, status: 'active' | 'unknown' = 'unknown'): LocalChangeRecoveryItem {
  return { invocationId: id, runId: `run-${id}`, conversationId: 'source', taskTitle: `Task ${id}`, occurredAt: '2026-10-15T00:00:00.000Z', affectedResources: [`/workspace/${id}.md`], reason: 'MUTATION_INTERRUPTED', status, revision: 'revision-1' }
}

function mount(records: readonly LocalChangeRecoveryItem[]) {
  const items = shallowRef(records)
  const waived = shallowRef(false)
  const decisions: Parameters<TaskChangeRecovery['resolve']>[0][] = []
  const recovery: TaskChangeRecovery = {
    conversationId: shallowRef<string | null>('current'),
    items,
    busy: shallowRef(false),
    error: shallowRef(null),
    waived,
    recheck: async () => {},
    resolve: async (input) => {
      decisions.push(input)
      items.value = items.value.filter(item => !input.items.some(selected => selected.invocationId === item.invocationId))
      waived.value = true
      return true
    },
    dismissWaived: () => { waived.value = false },
  }
  const root = document.createElement('div')
  document.body.append(root)
  const app = createApp(() => h(DesktopChangeRecoveryNotice, { recovery, language: 'zh-CN' }))
  app.mount(root)
  cleanups.push(() => {
    app.unmount()
    root.remove()
  })
  return { items, decisions, root }
}

function button(owner: ParentNode, label: string) {
  const found = [...owner.querySelectorAll('button')].find(element => element.textContent?.trim() === label)
  if (!found)
    throw new Error(`Button not found: ${label}`)
  return found
}

async function review(root: Element) {
  button(root, '更多选项').click()
  await vi.waitFor(() => expect(document.querySelector('.n-dropdown-option-body')).not.toBeNull())
  ;(document.querySelector('.n-dropdown-option-body') as HTMLElement).click()
  await vi.waitFor(() => expect(document.querySelector('.n-dialog')).not.toBeNull())
  return document.querySelector('.n-dialog')!
}

describe('change recovery confirmation', () => {
  it('keeps a fixed reviewed selection when additional historical warnings arrive', async () => {
    const f = mount([item('first'), item('running', 'active')])
    const dialog = await review(f.root)
    expect(f.root.textContent).toContain('这些历史记录不会阻止新操作')
    expect(f.root.textContent).toContain('重新读取文件并核对外部状态')
    expect(dialog.textContent).toContain('仅标记以下 1 项为已核对')
    expect(dialog.textContent).toContain('Task first')
    expect(dialog.textContent).not.toContain('Task running')
    expect(dialog.textContent).toContain('标记已核对不代表已确认此前的操作结束')
    expect(dialog.textContent).toContain('不会重新运行旧操作')
    expect(dialog.textContent).toContain('历史记录会保留')
    f.items.value = [...f.items.value, item('new')]
    await nextTick()
    expect(dialog.textContent).not.toContain('Task new')
    button(dialog, '标记已核对并接受风险').click()
    await nextTick()
    expect(f.decisions).toEqual([{ conversationId: 'current', decision: 'waived', items: [{ invocationId: 'first', revision: 'revision-1' }] }])
    expect(f.items.value.map(item => item.invocationId)).toEqual(['running', 'new'])
    expect(f.root.textContent).toContain('此前操作仍未确认结束')
  })

  it('requires a fresh review after the selected revision or status changes', async () => {
    const f = mount([item('first')])
    const dialog = await review(f.root)
    f.items.value = [{ ...item('first'), revision: 'revision-2', status: 'active' }]
    await nextTick()
    expect(button(dialog, '标记已核对并接受风险').disabled).toBe(true)
    expect(dialog.textContent).toContain('待处理事项已变化')
    button(dialog, '标记已核对并接受风险').click()
    await nextTick()
    expect(f.decisions).toEqual([])
    expect(f.items.value[0]?.status).toBe('active')
  })

  it('offers only rechecking for an active operation, without a fictitious stop action', async () => {
    const f = mount([item('running', 'active')])
    await nextTick()
    expect([...f.root.querySelectorAll('button')].map(button => button.textContent?.trim())).toEqual(['重新检查'])
    expect(f.root.textContent).toContain('此前的操作仍在运行')
  })
})
