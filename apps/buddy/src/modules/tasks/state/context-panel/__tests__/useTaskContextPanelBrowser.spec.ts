import type { ContextPanelState } from '@buddy-shared/context-panel/contextPanel'
import { describe, expect, it } from 'vitest'
import { nextTick, shallowRef } from 'vue'
import { deferred } from '../../../../../../__tests__/deferred'
import { useTaskContextPanel } from '../useTaskContextPanel'
import { contextPanelFixture, createTaskPanel } from './contextPanelFixture'

describe('resource panel ownership', () => {
  it('restores task tabs without changing visibility during navigation', async () => {
    const activeConversationId = shallowRef<string | null>('first')
    const panel = createTaskPanel({ activeConversationId })
    panel.openBrowser()
    activeConversationId.value = 'second'
    panel.openBrowser()
    await panel.toggle()
    activeConversationId.value = 'first'
    await nextTick()
    expect(panel.activeTab.value?.id).toBe('browser:first')
    expect(panel.isOpen.value).toBe(false)
    activeConversationId.value = 'second'
    expect(panel.activeTab.value?.id).toBe('browser:second')
    expect(panel.isOpen.value).toBe(false)
  })

  it('keeps the independent resource source and branch across task and module navigation', async () => {
    const activeConversationId = shallowRef<string | null>('first')
    const activeBranchId = shallowRef<string | null>('branch-first')
    const taskVisible = shallowRef(true)
    const mode = shallowRef<'task' | 'independent'>('independent')
    const panel = createTaskPanel({ mode, activeConversationId, activeBranchId, taskVisible })
    panel.openChanges()
    const original = panel.activeTab.value
    activeConversationId.value = 'second'
    activeBranchId.value = 'branch-second'
    taskVisible.value = false
    await nextTick()
    expect(panel.activeTab.value).toEqual(original)
    expect(panel.isOpen.value).toBe(true)
    panel.openBrowser()
    mode.value = 'task'
    expect(panel.tabs.value.map(tab => tab.id)).toEqual(['browser:second'])
    mode.value = 'independent'
    expect(panel.tabs.value.map(tab => tab.id)).toEqual(['changes:first', 'browser:second'])
  })

  it.each(['task', 'independent'] as const)('accepts explicit desktop presentation in %s mode and journals only visibility transitions', async (mode) => {
    const activeConversationId = shallowRef<string | null>('browser-task')
    const f = contextPanelFixture({ mode: shallowRef(mode), activeConversationId })
    const panel = f.scope.run(() => useTaskContextPanel(f.options))!
    const source = { conversationId: 'browser-task', runId: 'run-1' }
    await f.host.execute({ action: 'open', target: { kind: 'browser', source } }, 'harness')
    expect(panel.activeTab.value).toMatchObject({ id: 'browser:browser-task', source })
    expect(panel.isOpen.value).toBe(true)
    panel.addBrowser()
    expect(panel.activeTab.value).toMatchObject({ conversationId: null })
    await f.host.execute({ action: 'open', target: { kind: 'browser', source } }, 'harness')
    expect(panel.activeTab.value).toMatchObject({ id: 'browser:browser-task', source })
    expect(f.operations.map(({ action, actor }) => ({ action, actor }))).toEqual([{ action: 'open', actor: 'harness' }])
    await panel.toggle()
    expect(f.operations.at(-1)).toMatchObject({ action: 'close', actor: 'user', source })
    activeConversationId.value = 'another-task'
    await nextTick()
    expect(panel.isOpen.value).toBe(false)
    await f.host.execute({ action: 'open', target: { kind: 'browser', source } }, 'harness')
    expect(panel.isOpen.value).toBe(true)
    if (mode === 'task')
      expect(panel.activeTab.value).toBeNull()
    else
      expect(panel.activeTab.value).toMatchObject({ id: 'browser:browser-task', source })
    expect(f.operations.map(operation => operation.action)).toEqual(['open', 'close', 'open'])
  })

  it('queues background task presentation in its own scope without replacing the current task resources', async () => {
    const activeConversationId = shallowRef<string | null>('first')
    const f = contextPanelFixture({ activeConversationId })
    const panel = f.scope.run(() => useTaskContextPanel(f.options))!
    panel.addBrowser()
    const first = panel.activeTab.value
    const source = { conversationId: 'second', runId: 'run' }
    await f.host.execute({ action: 'open', target: { kind: 'browser', source } }, 'harness')
    expect(panel.tabs.value).toEqual([first])
    expect(panel.activeTab.value).toEqual(first)
    activeConversationId.value = 'second'
    expect(panel.tabs.value).toHaveLength(1)
    expect(panel.activeTab.value).toMatchObject({ id: 'browser:second', source })
    activeConversationId.value = 'first'
    expect(panel.activeTab.value).toEqual(first)
  })

  it('does not steal independent tabs when a background task presents a browser', async () => {
    const f = contextPanelFixture({ mode: shallowRef('independent'), activeConversationId: shallowRef('first') })
    const panel = f.scope.run(() => useTaskContextPanel(f.options))!
    panel.addBrowser()
    const selected = panel.activeTab.value
    const source = { conversationId: 'second', runId: 'background-run' }
    await f.host.execute({ action: 'open', target: { kind: 'browser', source } }, 'harness')
    expect(panel.activeTab.value).toEqual(selected)
    expect(panel.allTabs.value).toContainEqual(expect.objectContaining({ id: 'browser:second', source }))
  })

  it('retains independent resources without changing task selections or assigning them to the left task', () => {
    const activeConversationId = shallowRef<string | null>('first')
    const mode = shallowRef<'task' | 'independent'>('task')
    const panel = createTaskPanel({ activeConversationId, mode })
    panel.addBrowser()
    const first = panel.activeTab.value!
    panel.addBrowser()
    const alternate = panel.activeTab.value!
    panel.selectTab(first.id)
    activeConversationId.value = 'second'
    panel.addBrowser()
    const second = panel.activeTab.value!
    mode.value = 'independent'
    expect(panel.activeTab.value).toEqual(second)
    panel.selectTab(alternate.id)
    activeConversationId.value = 'first'
    expect(panel.activeTab.value).toEqual(alternate)
    panel.addBrowser()
    const independent = panel.activeTab.value!
    expect(independent.scope).toBe('independent')
    activeConversationId.value = 'second'
    expect(panel.activeTab.value).toEqual(independent)
    mode.value = 'task'
    expect(panel.tabs.value).toEqual([second])
    activeConversationId.value = 'first'
    expect(panel.tabs.value).toEqual([first, alternate])
    expect(panel.activeTab.value).toEqual(first)
    mode.value = 'independent'
    panel.selectTab(independent.id)
    panel.discardConversation('first')
    expect(panel.tabs.value).toEqual([second, independent])
    expect(panel.activeTab.value).toEqual(independent)
  })

  it('ignores stale initial snapshots after a desktop command and stops after disposal', async () => {
    const initial = deferred<ContextPanelState>()
    const f = contextPanelFixture()
    f.options.control.getState = () => initial.promise
    const panel = f.scope.run(() => useTaskContextPanel(f.options))!
    const source = { conversationId: 'task', runId: 'run' }
    await f.host.execute({ action: 'open', target: { kind: 'browser', source } }, 'harness')
    initial.resolve({ revision: 0, open: false, target: null })
    await nextTick()
    expect(panel.isOpen.value).toBe(true)
    f.scope.stop()
    await f.host.execute({ action: 'close', source })
    expect(panel.isOpen.value).toBe(true)
  })
})
