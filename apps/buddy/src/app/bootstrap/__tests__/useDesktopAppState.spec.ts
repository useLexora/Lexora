import type { LexoraDesktopApi } from '@buddy-electron/shared/desktopApi'
import type { LocalBuddyServiceSupervisorState } from '@buddy-shared/runtime/serviceState'

import { deferred } from '@buddy-tests/deferred'
import { describe, expect, it, vi } from 'vitest'

import { useDesktopAppState } from '../useDesktopAppState'

describe('useDesktopAppState', () => {
  it('initializes once and ignores startup replies after disposal', async () => {
    const status = deferred<LocalBuddyServiceSupervisorState>()
    const api = {
      localChat: {
        automations: emptyAutomationApi(),
        chat: emptyChatApi(),
        notifications: emptyNotificationApi(),
        providers: { list: async () => [], listModels: async () => [], getDefaultModel: async () => null, onChanged: () => () => {}, onAuthChallenge: () => () => {} },
        runtime: { getStatus: () => status.promise, onStateChanged: () => () => {} },
      },
      app: emptyUpdateApp(),
      settings: { get: async () => { throw new Error('unavailable') } },
    } as unknown as LexoraDesktopApi
    const appState = useDesktopAppState({ api })
    const first = appState.initialize()
    expect(appState.initialize()).toBe(first)
    appState.dispose()
    appState.dispose()
    status.resolve({ lastError: null, pid: 42, restartAttempt: 0, status: 'ready' })
    expect(await first).toBe(false)
    expect(await appState.initialize()).toBe(false)
    expect(appState.stores.runtimeSupervisor.runtimeState.value.status).toBe('stopped')
    expect(appState.stores.notifications.items.value).toEqual([])
    expect(appState.stores.modelProviders.models.value).toEqual([])
  })

  it('derives a localized safe runtime failure from the runtimeSupervisor code', async () => {
    let onStateChanged: ((state: LocalBuddyServiceSupervisorState) => void) | undefined
    const api = {
      localChat: {
        automations: emptyAutomationApi(),
        chat: emptyChatApi(),
        notifications: emptyNotificationApi(),
        providers: {
          onChanged: () => () => {},
          onAuthChallenge: () => () => {},
        },
        runtime: {
          onStateChanged: (listener: (state: LocalBuddyServiceSupervisorState) => void) => {
            onStateChanged = listener
            return () => {}
          },
        },
      },
      app: emptyUpdateApp(),
      settings: {
        update: async () => ({
          desktop: {
            language: 'en-US',
            launchAtLogin: false,
            sidebarCollapsed: false,
            theme: 'system',
          },
        }),
      },
    } as unknown as LexoraDesktopApi
    const appState = useDesktopAppState({ api })

    onStateChanged?.({
      lastError: 'EVENT_LOG_CORRUPTED',
      pid: null,
      restartAttempt: 5,
      status: 'offline',
    })
    expect(appState.stores.runtimeSupervisor.runtimeError.value).toBe('本地事件日志已损坏，无法安全启动 Buddy')
    expect(appState.stores.runtimeSupervisor.canRestartRuntime.value).toBe(true)
    onStateChanged?.({ lastError: 'RUNTIME_TERMINATION_FAILED', pid: 42, restartAttempt: 5, status: 'offline' })
    expect(appState.stores.runtimeSupervisor.canRestartRuntime.value).toBe(false)
    onStateChanged?.({ lastError: 'EVENT_LOG_CORRUPTED', pid: null, restartAttempt: 5, status: 'offline' })

    await appState.stores.applicationSettings.updateSettings({ desktop: { language: 'en-US' } })
    expect(appState.stores.runtimeSupervisor.runtimeError.value)
      .toBe('The local event log is corrupted, so Buddy cannot start safely.')
    appState.dispose()
  })

  it('does not replace an event-driven runtime state with a stale startup snapshot', async () => {
    let resolveStatus: ((state: LocalBuddyServiceSupervisorState) => void) | undefined
    let onStateChanged: ((state: LocalBuddyServiceSupervisorState) => void) | undefined
    const api = {
      localChat: {
        automations: emptyAutomationApi(),
        chat: emptyChatApi(),
        notifications: emptyNotificationApi(),
        providers: {
          list: async () => [],
          listModels: async () => [],
          onChanged: () => () => {},
          onAuthChallenge: () => () => {},
        },
        runtime: {
          getStatus: () => new Promise<LocalBuddyServiceSupervisorState>((resolve) => {
            resolveStatus = resolve
          }),
          onStateChanged: (listener: (state: LocalBuddyServiceSupervisorState) => void) => {
            onStateChanged = listener
            return () => {}
          },
        },
      },
      app: emptyUpdateApp(),
      settings: {
        get: () => Promise.reject(new Error('settings unavailable')),
      },
    } as unknown as LexoraDesktopApi
    const appState = useDesktopAppState({ api })
    const initialization = appState.initialize()

    await vi.waitFor(() => expect(resolveStatus).toBeTypeOf('function'))

    onStateChanged?.({
      lastError: null,
      pid: 42,
      restartAttempt: 0,
      status: 'ready',
    })
    resolveStatus?.({
      lastError: null,
      pid: 42,
      restartAttempt: 0,
      status: 'starting',
    })
    expect(await initialization).toBe(false)

    expect(appState.stores.runtimeSupervisor.runtimeState.value.status).toBe('ready')
    appState.dispose()
  })
})

function emptyUpdateApp() {
  return { updates: { onChanged: () => () => {}, getState: async () => ({ revision: 0, enabled: true, checking: false, result: null, notification: null, reminderDueAt: null }) } }
}

function emptyNotificationApi() {
  return {
    onChanged: () => () => {},
    list: async () => ({ items: [], unseenCount: 0 }),
  }
}

function emptyAutomationApi() {
  return {
    onChanged: () => () => {},
  }
}

function emptyChatApi() {
  return {
    onRunEvent: () => () => {},
  }
}
