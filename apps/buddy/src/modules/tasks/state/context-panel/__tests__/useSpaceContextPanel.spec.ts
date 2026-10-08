import type { DesktopContextPanelMode } from '@buddy-electron/shared/desktopApi'
import { describe, expect, it } from 'vitest'
import { nextTick, shallowRef } from 'vue'
import { useTaskContextPanel } from '../useTaskContextPanel'
import { contextPanelFixture, createTaskPanel } from './contextPanelFixture'

function fixture(mode: DesktopContextPanelMode = 'space') {
  const options = {
    mode: shallowRef<DesktopContextPanelMode>(mode),
    activeConversationId: shallowRef<string | null>('a'),
    activeDraftId: shallowRef<string | null>(null),
    scopeSpaceIds: shallowRef<ReadonlyMap<string, string | null>>(new Map([
      ['task:a', 'first'],
      ['task:b', 'first'],
      ['task:c', 'second'],
      ['task:unbound-a', null],
      ['task:unbound-b', null],
      ['draft:new', 'first'],
    ])),
  }
  const hostFixture = contextPanelFixture(options)
  const panel = hostFixture.scope.run(() => useTaskContextPanel(hostFixture.options))!
  return { ...options, panel, host: hostFixture.host }
}

describe('space-linked resources', () => {
  it('shares tabs and selection by space identity without requiring a working directory', () => {
    const f = fixture()
    f.panel.addBrowser()
    const first = f.panel.activeTab.value!
    f.panel.openChanges()
    const changes = f.panel.activeTab.value!
    f.panel.selectTab(first.id)
    f.activeConversationId.value = 'b'
    expect(f.panel.tabs.value).toEqual([first, changes])
    expect(f.panel.activeTab.value).toEqual(first)
    expect(f.panel.canAddChanges.value).toBe(true)
    f.panel.openChanges()
    const secondTaskChanges = f.panel.activeTab.value!
    f.activeConversationId.value = 'a'
    expect(f.panel.activeTab.value).toEqual(secondTaskChanges)
    expect(f.panel.canAddChanges.value).toBe(false)
    expect(f.panel.fileEntry.value).toBeNull()
    f.activeConversationId.value = 'c'
    expect(f.panel.tabs.value).toEqual([])
    f.panel.addBrowser()
    const otherSpace = f.panel.activeTab.value!
    f.activeConversationId.value = 'b'
    expect(f.panel.activeTab.value).toEqual(secondTaskChanges)
    f.activeConversationId.value = 'c'
    expect(f.panel.activeTab.value).toEqual(otherSpace)
  })

  it('keeps tasks and drafts without a space isolated', () => {
    const f = fixture()
    const ids = ['unbound-a', 'unbound-b']
    const tabs = ids.map((id) => {
      f.activeConversationId.value = id
      expect(f.panel.tabs.value).toEqual([])
      f.panel.addBrowser()
      return f.panel.activeTab.value!
    })
    f.activeConversationId.value = null
    f.activeDraftId.value = 'unbound-draft'
    expect(f.panel.tabs.value).toEqual([])
    f.panel.addBrowser()
    const draft = f.panel.activeTab.value!
    ids.forEach((id, index) => {
      f.activeConversationId.value = id
      expect(f.panel.tabs.value).toEqual([tabs[index]])
    })
    f.activeConversationId.value = null
    expect(f.panel.tabs.value).toEqual([draft])
  })

  it('retains separate selections when changing modes and never reassigns resource ownership', () => {
    const f = fixture('task')
    f.panel.addBrowser()
    const first = f.panel.activeTab.value!
    f.panel.addBrowser()
    const alternate = f.panel.activeTab.value!
    f.panel.selectTab(first.id)
    f.activeConversationId.value = 'b'
    f.panel.addBrowser()
    const second = f.panel.activeTab.value!
    f.activeConversationId.value = 'a'
    f.mode.value = 'space'
    expect(f.panel.tabs.value).toEqual([first, alternate, second])
    expect(f.panel.activeTab.value).toEqual(first)
    f.panel.selectTab(second.id)
    f.mode.value = 'independent'
    expect(f.panel.activeTab.value).toEqual(second)
    f.panel.addBrowser()
    const independent = f.panel.activeTab.value!
    f.mode.value = 'task'
    expect(f.panel.tabs.value).toEqual([first, alternate])
    expect(f.panel.activeTab.value).toEqual(first)
    f.mode.value = 'space'
    expect(f.panel.activeTab.value).toEqual(second)
    expect(f.panel.tabs.value).not.toContainEqual(independent)
    expect(f.panel.allTabs.value).toEqual([first, alternate, second, independent])
  })

  it('restores a space selection even when task membership is loaded after the snapshot', () => {
    const f = fixture()
    f.panel.addBrowser()
    const selected = f.panel.activeTab.value!
    f.activeConversationId.value = 'b'
    f.panel.addBrowser()
    f.panel.selectTab(selected.id)
    const spaceIds = shallowRef<ReadonlyMap<string, string | null>>(new Map())
    const restored = createTaskPanel({ mode: f.mode, activeConversationId: f.activeConversationId, scopeSpaceIds: spaceIds })
    restored.restoreSnapshot(JSON.parse(JSON.stringify(f.panel.snapshot())))
    spaceIds.value = f.scopeSpaceIds.value
    expect(restored.tabs.value).toEqual(f.panel.tabs.value)
    expect(restored.activeTab.value).toEqual(selected)
  })

  it('keeps the existing last-tab fallback when restoring task tabs without saved selections', () => {
    const f = fixture('task')
    f.panel.addBrowser()
    f.panel.addBrowser()
    const restored = createTaskPanel({ activeConversationId: f.activeConversationId })
    restored.restoreSnapshot({ tabs: f.panel.snapshot().tabs })
    expect(restored.activeTab.value).toEqual(f.panel.activeTab.value)
  })

  it('moves task resources with their space membership and deletes only the owning task resources', () => {
    const f = fixture()
    f.panel.addBrowser()
    const first = f.panel.activeTab.value!
    f.activeConversationId.value = 'b'
    f.panel.addBrowser()
    const second = f.panel.activeTab.value!
    f.scopeSpaceIds.value = new Map([...f.scopeSpaceIds.value, ['task:b', 'second']])
    expect(f.panel.tabs.value).toEqual([second])
    f.activeConversationId.value = 'a'
    expect(f.panel.tabs.value).toEqual([first])
    f.scopeSpaceIds.value = new Map([...f.scopeSpaceIds.value, ['task:b', 'first']])
    f.panel.selectTab(second.id)
    f.panel.discardConversation('b')
    f.panel.restoreTab(second)
    expect(f.panel.tabs.value).toEqual([first])
    expect(f.panel.activeTab.value).toEqual(first)
  })

  it('shares draft resources and preserves selection through draft submission', () => {
    const f = fixture()
    f.activeConversationId.value = null
    f.activeDraftId.value = 'new'
    f.panel.addBrowser()
    const draft = f.panel.activeTab.value!
    f.activeConversationId.value = 'a'
    expect(f.panel.activeTab.value).toEqual(draft)
    f.scopeSpaceIds.value = new Map([...f.scopeSpaceIds.value, ['task:submitted', 'first']])
    f.panel.adoptDraft('new', 'submitted')
    expect(f.panel.activeTab.value).toEqual({ ...draft, scope: 'task:submitted' })
    f.activeConversationId.value = 'submitted'
    expect(f.panel.activeTab.value?.id).toBe(draft.id)
    f.panel.discardConversation('submitted')
    expect(f.panel.tabs.value).toEqual([])
  })

  it('remembers the selected draft resource after moving to a space without a selection', async () => {
    const f = fixture()
    f.activeConversationId.value = null
    f.activeDraftId.value = 'new'
    f.panel.addBrowser()
    const selected = f.panel.activeTab.value!

    f.scopeSpaceIds.value = new Map([...f.scopeSpaceIds.value, ['draft:new', 'second']])
    expect(f.panel.activeTab.value).toBe(selected)
    expect(f.panel.snapshot().selections).toContainEqual(['space:second', selected.id])

    await f.host.execute({ action: 'open', target: { kind: 'browser', source: { conversationId: 'c', runId: 'run-c' } } }, 'harness')
    await nextTick()
    expect(f.panel.tabs.value.map(tab => tab.id)).toEqual([selected.id, 'browser:c'])
    expect(f.panel.activeTab.value).toBe(selected)
  })

  it('remembers the remaining resource when the selected resource moves out of the current space', async () => {
    const f = fixture()
    f.panel.addBrowser()
    const remaining = f.panel.activeTab.value!
    f.activeConversationId.value = null
    f.activeDraftId.value = 'new'
    f.panel.addBrowser()
    const draft = f.panel.activeTab.value!
    f.activeConversationId.value = 'a'
    expect(f.panel.activeTab.value).toBe(draft)

    f.scopeSpaceIds.value = new Map([...f.scopeSpaceIds.value, ['draft:new', 'second']])
    expect(f.panel.activeTab.value).toBe(remaining)
    expect(f.panel.snapshot().selections).toContainEqual(['space:first', remaining.id])

    await f.host.execute({ action: 'open', target: { kind: 'browser', source: { conversationId: 'b', runId: 'run-b' } } }, 'harness')
    await nextTick()
    expect(f.panel.tabs.value.map(tab => tab.id)).toEqual([remaining.id, 'browser:b'])
    expect(f.panel.activeTab.value).toBe(remaining)
  })

  it('keeps the selection when a background task in the same space presents resources', async () => {
    const f = fixture()
    const { panel } = f
    panel.addBrowser()
    const selected = panel.activeTab.value!
    const source = { conversationId: 'b', runId: 'run-b' }
    await f.host.execute({ action: 'open', target: { kind: 'browser', source } }, 'harness')
    await nextTick()
    expect(panel.tabs.value.map(tab => tab.id)).toEqual([selected.id, 'browser:b'])
    expect(panel.activeTab.value).toEqual(selected)
    f.activeConversationId.value = 'b'
    expect(panel.activeTab.value).toEqual(selected)
  })
})
