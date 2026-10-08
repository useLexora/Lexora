// @vitest-environment jsdom
import type { DesktopBrowserApi, DesktopBrowserState } from '@buddy-electron/shared/desktopApi'
import type { BrowserPickResult } from '@buddy-shared/browser/browserSelection'
import type { SelectionReferenceTarget } from '@/shared/ui/selection/workbenchSelectionReferences'
import { browserQuote } from '@buddy-shared/browser/__tests__/browserSelectionFixture'
import { createBuddyUserContent } from '@buddy-shared/conversation/buddyUserContent'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, provide, shallowRef } from 'vue'
import { WorkbenchSelectionReferences, workbenchSelectionReferencesKey } from '@/shared/ui/selection/workbenchSelectionReferences'
import { browserElementPickMenuPosition, useBrowserElementReference } from '../useBrowserElementReference'

const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).forEach(cleanup => cleanup()))
function fixture(multiple = false, owner: string | null = 'task:a') {
  const body = shallowRef(createBuddyUserContent('Original'))
  const write = vi.fn(value => body.value = value)
  const targets: SelectionReferenceTarget[] = [{ id: 'a', identity: 'draft:a:branch:0', scope: 'task:a', label: 'A', read: () => body.value, write }]
  if (multiple)
    targets.push({ ...targets[0]!, id: 'b', identity: 'draft:b:branch:0', scope: 'task:b', label: 'B' })
  let sourceIdentity = 'page:1'
  const references = new WorkbenchSelectionReferences({ targets: () => targets, source: () => ({ identity: sourceIdentity, owner }), locate: async () => false })
  let resolve!: (result: BrowserPickResult) => void
  const api = { pickElement: vi.fn(() => new Promise<BrowserPickResult>(done => resolve = done)), cancelElementPick: vi.fn(async () => {}) } as unknown as DesktopBrowserApi
  const state = shallowRef<DesktopBrowserState>({ sessionId: 'session', pageId: 'page', documentVersion: 1, url: 'https://example.com/', status: 'ready', controller: 'human' } as DesktopBrowserState)
  const visible = shallowRef(true)
  const feedback = vi.fn()
  const choose = vi.fn()
  let picker!: ReturnType<typeof useBrowserElementReference>
  const root = document.createElement('div')
  const app = createApp(defineComponent({ setup() {
    provide(workbenchSelectionReferencesKey, references)
    return () => h(defineComponent({ setup() {
      picker = useBrowserElementReference({ api, state, visible, viewId: shallowRef('browser:tab'), feedback, choose })
      return () => null
    } }))
  } }))
  app.mount(root)
  cleanups.push(() => app.unmount())
  const selected = { status: 'selected' as const, text: browserQuote.text, element: browserQuote.element, source: browserQuote.source, anchor: { x: 0.25, y: 0.4 } }
  return { picker, api, state, visible, feedback, choose, body, write, targets, references, selected, resolve: () => resolve(selected), source: () => sourceIdentity = 'page:2' }
}
describe('browser element reference routing lifecycle', () => {
  it('maps viewport ratios into workbench CSS coordinates, including resizing and zoom', () => {
    const anchor = { x: 0.25, y: 0.4 }
    expect(browserElementPickMenuPosition(anchor, { left: 500, top: 120, width: 800, height: 600 })).toEqual({ x: 700, y: 360 })
    expect(browserElementPickMenuPosition(anchor, { left: 100, top: 80, width: 400, height: 300 })).toEqual({ x: 200, y: 200 })
  })
  it('preserves latest text and writes once to the frozen default without broadcasting', async () => {
    const f = fixture()
    const pending = f.picker.toggle()
    f.body.value = createBuddyUserContent('Typed during picking')
    f.resolve()
    await pending
    expect(f.write).toHaveBeenCalledOnce()
    expect(f.body.value.body).toEqual(createBuddyUserContent('Typed during picking').body)
    expect(f.body.value.resourceQuotes?.[0]).toMatchObject({ source: browserQuote.source, text: browserQuote.text, element: browserQuote.element })
    expect(f.feedback).toHaveBeenCalledWith('added', 'A')
    expect(f.body.value.resourceQuotes?.[0]).not.toHaveProperty('anchor')
  })
  it.each(['target', 'source'])('rejects a changed %s and never silently reroutes', async (change) => {
    const f = fixture()
    const pending = f.picker.toggle()
    if (change === 'target')
      f.targets[0]!.identity += ':sent'
    else f.source()
    f.resolve()
    await pending
    expect(f.write).not.toHaveBeenCalled()
    expect(f.feedback).toHaveBeenCalledWith('unavailable', ...(change === 'target' ? ['A'] : []))
  })
  it('requires explicit selection among multiple independent drafts and freezes candidate identities', async () => {
    const f = fixture(true, null)
    const pending = f.picker.toggle()
    f.targets[1]!.identity += ':new-branch'
    f.resolve()
    await pending
    expect(f.choose).toHaveBeenCalledWith(expect.anything(), f.selected.anchor)
    const request = f.choose.mock.calls[0]![0]
    expect(request.defaultId).toBeNull()
    expect(f.references.add(request, 'b')).toBe('unavailable')
    expect(f.write).not.toHaveBeenCalled()
  })
  it.each(['hide', 'navigate', 'escape'])('cancels on %s and ignores a late result', async (change) => {
    const f = fixture()
    const pending = f.picker.toggle()
    if (change === 'hide')
      f.visible.value = false
    else if (change === 'navigate')
      f.state.value = { ...f.state.value, documentVersion: 2 }
    else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await nextTick()
    f.resolve()
    await pending
    expect(f.api.cancelElementPick).toHaveBeenCalledOnce()
    expect(f.write).not.toHaveBeenCalled()
    expect(f.feedback).not.toHaveBeenCalled()
  })
})
