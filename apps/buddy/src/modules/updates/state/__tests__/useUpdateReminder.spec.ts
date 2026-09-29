// @vitest-environment jsdom
import type { DesktopUpdateRecord } from '@buddy-electron/main/updates/DesktopUpdateStore'
import type { LocalRunEvent } from '@buddy-shared/runs/runApi'
import { DesktopUpdates } from '@buddy-electron/main/updates/DesktopUpdates'
import { emptyUpdateRecord } from '@buddy-electron/main/updates/DesktopUpdateStore'
import { deferred } from '@buddy-tests/deferred'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, shallowRef } from 'vue'
import { useDesktopUpdates } from '../useDesktopUpdates'
import { useUpdateReminder } from '../useUpdateReminder'

const cleanups: Array<() => Promise<void>> = []
beforeEach(() => vi.useFakeTimers())
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()))
  vi.useRealTimers()
})

async function fixture(pauseSave = false) {
  const root = document.createElement('div')
  document.body.append(root)
  const delivery = deferred<void>()
  const persistence = deferred<void>()
  const focused = shallowRef(true)
  const environment = { idle: true }
  const result = { currentVersion: '1.0.0', latestVersion: '1.1.0', status: 'update_available' as const, releaseUrl: 'https://github.com/useLexora/Lexora/releases/tag/v1.1.0', releaseNotes: '' }
  let saved: DesktopUpdateRecord = { ...emptyUpdateRecord(), result, discoveredAt: Date.now() }
  const renderedAtCommit: Array<string | null> = []
  const owner = new DesktopUpdates({
    currentVersion: '1.0.0',
    automatic: false,
    enabled: true,
    store: {
      read: async () => saved,
      write: async (record) => {
        renderedAtCommit.push(root.textContent)
        if (pauseSave)
          await persistence.promise
        saved = structuredClone(record)
      },
    },
    check: async () => result,
    canPresent: () => focused.value,
    isIdle: async () => environment.idle,
    reportFailure: () => {},
  })
  await owner.start()
  owner.setReady(true)
  const updates = useDesktopUpdates({
    checkForUpdates: () => owner.check(),
    updates: {
      getState: async () => owner.state,
      onChanged: listener => owner.onDidChange(listener).dispose,
      acknowledge: input => owner.acknowledge(input),
      takeReminder: async () => {
        const candidate = await owner.takeReminder()
        await delivery.promise
        return candidate
      },
    },
  })
  await updates.load()
  let runEvent = (_event: LocalRunEvent) => {}
  const app = createApp({
    setup() {
      const { reminder } = useUpdateReminder(updates, focused, {
        chat: { onRunEvent: (listener) => {
          runEvent = listener
          return () => {
            runEvent = () => {}
          }
        } },
      })
      return () => reminder.value ? h('aside', reminder.value.latestVersion) : null
    },
  })
  app.mount(root)
  let mounted = true
  function unmount() {
    if (mounted)
      app.unmount()
    mounted = false
  }
  cleanups.push(async () => {
    unmount()
    updates.dispose()
    delivery.resolve()
    persistence.resolve()
    await owner.dispose()
    root.remove()
  })
  return {
    root,
    owner,
    focused,
    environment,
    delivery,
    persistence,
    renderedAtCommit,
    unmount,
    saved: () => saved,
    event: (type: string) => runEvent({ type, runId: 'fixture-run', sequence: 1, createdAt: new Date().toISOString(), payload: {} }),
  }
}

it.each(['run.started', 'approval.requested'])('retries a reminder discarded by %s before display without consuming its cooldown', async (event) => {
  const f = await fixture()
  await vi.advanceTimersByTimeAsync(0)
  f.environment.idle = false
  f.event(event)
  f.delivery.resolve()
  await vi.advanceTimersByTimeAsync(0)
  expect(f.root.textContent).toBe('')
  expect(f.saved()).toMatchObject({ notifiedVersion: null, lastNotifiedAt: null })
  expect(f.owner.state.reminderDueAt).toBe(0)
  f.environment.idle = true
  f.event(event === 'run.started' ? 'run.completed' : 'approval.resolved')
  await vi.advanceTimersByTimeAsync(1000)
  expect(f.root.textContent).toBe('1.1.0')
  expect(f.saved()).toMatchObject({ notifiedVersion: '1.1.0', lastNotifiedAt: Date.now() })
  expect(f.owner.state.notification?.attention).toBe('unseen')
  expect(f.owner.state.reminderDueAt).toBeNull()
})

it('starts persistence only after rendering, so a task starting during the write cannot consume an unseen reminder', async () => {
  const f = await fixture(true)
  f.delivery.resolve()
  await vi.advanceTimersByTimeAsync(0)
  expect(f.renderedAtCommit).toEqual(['1.1.0'])
  expect(f.root.textContent).toBe('1.1.0')
  expect(f.saved().notifiedVersion).toBeNull()
  f.environment.idle = false
  f.event('run.started')
  await nextTick()
  expect(f.root.textContent).toBe('')
  f.persistence.resolve()
  await vi.advanceTimersByTimeAsync(0)
  expect(f.saved().notifiedVersion).toBe('1.1.0')
  f.environment.idle = true
  f.event('run.completed')
  await vi.advanceTimersByTimeAsync(30_000)
  expect(f.root.textContent).toBe('')
})

it.each(['blur', 'unmount'])('keeps an unshown reminder eligible when %s occurs before its reply', async (interruption) => {
  const f = await fixture()
  await vi.advanceTimersByTimeAsync(0)
  if (interruption === 'blur')
    f.focused.value = false
  else
    f.unmount()
  f.delivery.resolve()
  await vi.advanceTimersByTimeAsync(0)
  expect(f.root.textContent).toBe('')
  expect(f.saved()).toMatchObject({ notifiedVersion: null, lastNotifiedAt: null })
  expect(f.owner.state.reminderDueAt).toBe(0)
  if (interruption === 'blur') {
    f.focused.value = true
    await nextTick()
    await vi.advanceTimersByTimeAsync(0)
    expect(f.root.textContent).toBe('1.1.0')
    expect(f.saved().notifiedVersion).toBe('1.1.0')
  }
})
