// @vitest-environment jsdom
import type { DesktopBrowserApi, DesktopBrowserState } from '@buddy-electron/shared/desktopApi'
import type { BrowserGuestSurface } from '@/platform/browser/browserGuestSurface'
import { browserAgentTabId } from '@buddy-shared/browser/session'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, effectScope, h, nextTick, shallowRef } from 'vue'
import { deferred } from '../../../../../../__tests__/deferred'
import { useBrowserAddress } from '../useBrowserAddress'
import { useBrowserContextSurface } from '../useBrowserContextSurface'
import { useBrowserSurface } from '../useBrowserSurface'

const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).forEach(cleanup => cleanup()))

function browserState(url = 'https://example.com/'): DesktopBrowserState {
  return { zoomFactor: 1, canGoBack: false, canGoForward: false, controller: 'human', controlEpoch: 0, conversationId: 'conversation', error: null, pageId: 'page', profileMode: 'default', security: { kind: 'blank', origin: null }, sessionId: 'session', status: 'ready', title: '', url, visible: true }
}

function mountBrowser(ensureSession: DesktopBrowserApi['ensureSession'] = async () => browserState(), initialState: DesktopBrowserState | null = null, tabId?: string) {
  const state = shallowRef<DesktopBrowserState | null>(initialState)
  let hook!: ReturnType<typeof useBrowserContextSurface>
  const api = {
    ensureSession: vi.fn(ensureSession),
    navigate: vi.fn(),
    takeControl: vi.fn(),
    setProfileMode: vi.fn(),
    setSurface: vi.fn().mockResolvedValue(undefined),
  }
  const app = createApp({ setup() {
    hook = useBrowserContextSurface({
      state,
      sessionReady: (next) => {
        if (state.value?.sessionId !== next.sessionId)
          state.value = next
      },
      updateState: (next) => {
        state.value = next
      },
      api: api as unknown as DesktopBrowserApi,
      conversationId: shallowRef('conversation'),
      tabId: shallowRef(tabId),
      guestHost: { show() {}, hide() {} },
      surfaceElement: shallowRef(document.createElement('div')),
    })
    return () => h('div')
  } })
  app.mount(document.createElement('div'))
  let stopped = false
  const stop = () => {
    if (!stopped) {
      stopped = true
      app.unmount()
    }
  }
  cleanups.push(stop)
  return { api, hook, stop, publish: (next: DesktopBrowserState) => {
    state.value = next
  } }
}

describe('browser context ownership', () => {
  it('shows initialization work, exposes failure and can retry without replacing the tab', async () => {
    const initial = deferred<DesktopBrowserState>()
    const { api, hook } = mountBrowser(() => initial.promise)
    expect(hook.isLoading.value).toBe(true)
    initial.reject(new Error('session unavailable'))
    await nextTick()
    expect(hook.isLoading.value).toBe(false)
    expect(hook.failed.value).toBe(true)
    const retry = deferred<DesktopBrowserState>()
    api.ensureSession.mockReturnValueOnce(retry.promise)
    const retrying = hook.retry()
    expect(hook.isLoading.value).toBe(true)
    expect(hook.failed.value).toBe(false)
    retry.resolve(browserState())
    await retrying
    expect(hook.state.value?.sessionId).toBe('session')
    expect(hook.isLoading.value).toBe(false)
    expect(hook.failed.value).toBe(false)
  })

  it('preserves the owner page through human control and profile replacement', async () => {
    const key = browserAgentTabId('child-run')
    let hostState: DesktopBrowserState = {
      ...browserState(),
      sessionId: 'child-session',
      controller: 'agent',
      owner: { runId: 'child-run', buddyId: 'child' },
    }
    const ensure: DesktopBrowserApi['ensureSession'] = async (conversationId, tabId) => {
      if (conversationId !== hostState.conversationId || tabId !== key)
        throw new Error('BROWSER_SESSION_NOT_FOUND')
      return hostState
    }
    const { api, hook } = mountBrowser(ensure, hostState, key)
    await nextTick()
    api.takeControl.mockImplementation(async (sessionId: string) => {
      if (sessionId !== hostState.sessionId)
        throw new Error('BROWSER_SESSION_NOT_FOUND')
      hostState = { ...hostState, controller: 'human', controlEpoch: hostState.controlEpoch + 1 }
      return hostState
    })
    expect(await hook.takeControl()).toBe(true)
    expect(hook.state.value).toMatchObject({
      sessionId: 'child-session',
      controller: 'human',
      owner: { runId: 'child-run', buddyId: 'child' },
    })
    expect(hook.failed.value).toBe(false)
    const replacement = { ...hostState, sessionId: 'private-session', pageId: 'private-page', profileMode: 'incognito' as const }
    api.setProfileMode.mockResolvedValue(replacement)
    expect(await hook.setProfileMode('incognito')).toBe(true)
    expect(hook.state.value).toEqual(replacement)
  })

  it('keeps the newest navigation result when commands finish out of order', async () => {
    const { api, hook } = mountBrowser()
    await nextTick()
    const first = deferred<DesktopBrowserState>()
    const second = deferred<DesktopBrowserState>()
    api.navigate.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const a = hook.navigate('a.example')
    const b = hook.navigate('b.example')
    second.resolve(browserState('https://b.example/'))
    expect(await b).toBe(true)
    first.resolve(browserState('https://a.example/'))
    expect(await a).toBe(false)
    expect(hook.state.value?.url).toBe('https://b.example/')
  })

  it('does not overwrite a published host state or write after unmount', async () => {
    const { api, hook, publish, stop } = mountBrowser()
    await nextTick()
    const pending = deferred<DesktopBrowserState>()
    api.navigate.mockReturnValueOnce(pending.promise)
    const action = hook.navigate('requested.example')
    publish(browserState('https://redirected.example/'))
    pending.resolve(browserState('https://requested.example/'))
    await action
    expect(hook.state.value?.url).toBe('https://redirected.example/')
    const last = deferred<DesktopBrowserState>()
    api.navigate.mockReturnValueOnce(last.promise)
    const lastAction = hook.navigate('disposed.example')
    stop()
    last.resolve(browserState('https://disposed.example/'))
    expect(await lastAction).toBe(false)
    expect(hook.state.value?.url).toBe('https://redirected.example/')
  })

  it('keeps input entered while navigation is pending, including A to B to A edits', async () => {
    const scope = effectScope()
    cleanups.push(() => scope.stop())
    const state = shallowRef<DesktopBrowserState | null>(browserState())
    const pending = deferred<boolean>()
    const address = scope.run(() => useBrowserAddress(state, () => pending.promise))!
    address.updateAddress('a.example')
    const opening = address.openAddress()
    address.updateAddress('b.example')
    address.updateAddress('a.example')
    state.value = browserState('https://navigated.example/')
    pending.resolve(true)
    await opening
    expect(address.address.value).toBe('a.example')
  })

  it('publishes only the current page and mount acknowledgement, including A → B → A', () => {
    const scope = effectScope()
    cleanups.push(() => scope.stop())
    const sessionId = shallowRef('session')
    const pageId = shallowRef('page-a')
    const element = shallowRef(document.createElement('div'))
    const visible = shallowRef(true)
    const mounts: BrowserGuestSurface[] = []
    const mounted = new Set<BrowserGuestSurface>()
    const host = {
      show: (_: string, surface: BrowserGuestSurface) => {
        mounts.push(surface)
        mounted.add(surface)
      },
      hide: (_: string, surface: BrowserGuestSurface) => mounted.delete(surface),
    }
    const ready = scope.run(() => useBrowserSurface({ guestHost: host, sessionId, pageId, element, visible }))!
    expect(ready.value).toBe(false)
    pageId.value = 'page-b'
    pageId.value = 'page-a'
    mounts[0]!.onPresented()
    mounts[1]!.onPresented()
    expect(ready.value).toBe(false)
    expect([...mounted]).toEqual([mounts[2]])
    mounts[2]!.onPresented()
    expect(ready.value).toBe(true)
    visible.value = false
    mounts[2]!.onPresented()
    expect(ready.value).toBe(false)
    expect(mounted.size).toBe(0)
    visible.value = true
    expect(ready.value).toBe(false)
    mounts[3]!.onPresented()
    expect(ready.value).toBe(true)
    scope.stop()
    expect(mounted.size).toBe(0)
  })
})
