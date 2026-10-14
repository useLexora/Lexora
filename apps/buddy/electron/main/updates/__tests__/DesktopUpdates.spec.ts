import type { DesktopUpdateCheckResult } from '../../../shared/desktopUpdates'
import type { DesktopUpdatesOptions } from '../DesktopUpdates'
import type { DesktopUpdateRecord } from '../DesktopUpdateStore'
import { deferred } from '@buddy-tests/deferred'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DesktopUpdates, UPDATE_CHECK_INTERVAL, UPDATE_REMINDER_INTERVAL, UPDATE_STARTUP_DELAY } from '../DesktopUpdates'
import { emptyUpdateRecord } from '../DesktopUpdateStore'

const services: DesktopUpdates[] = []
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
})
afterEach(async () => {
  await Promise.all(services.splice(0).map(service => service.dispose()))
  vi.useRealTimers()
})

function release(version = '1.1.0'): DesktopUpdateCheckResult {
  return { currentVersion: '1.0.0', latestVersion: version, status: 'update_available', releaseUrl: `https://github.com/useLexora/Lexora/releases/tag/v${version}`, releaseNotes: '- Restore tasks safely' }
}

async function fixture(options: Partial<DesktopUpdatesOptions> = {}, initial = emptyUpdateRecord()) {
  let saved = structuredClone(initial)
  const environment = { focused: true, idle: true, latest: '1.1.0' }
  const store = {
    read: async () => structuredClone(saved),
    write: async (record: DesktopUpdateRecord) => {
      saved = structuredClone(record)
    },
  }
  const errors: string[] = []
  const input: DesktopUpdatesOptions = {
    currentVersion: '1.0.0',
    automatic: true,
    enabled: true,
    store,
    check: async () => release(environment.latest),
    canPresent: () => environment.focused,
    isIdle: async () => environment.idle,
    reportFailure: () => errors.push('background'),
    ...options,
  }
  const service = new DesktopUpdates(input)
  services.push(service)
  await service.start()
  service.setReady(true)
  return { service, input, environment, errors, saved: () => saved }
}

async function discover(f: Awaited<ReturnType<typeof fixture>>) {
  await vi.advanceTimersByTimeAsync(UPDATE_STARTUP_DELAY)
  expect(f.service.state.result?.status).toBe('update_available')
}

describe('desktop update ownership and notification policy', () => {
  it('persists explicit reminder deferral across restarts, waits for idle, and does not consume it with stale display acknowledgements', async () => {
    const f = await fixture()
    await discover(f)
    await f.service.acknowledge({ action: 'reminded', version: '1.1.0' })
    await f.service.acknowledge({ action: 'snooze', version: '1.1.0', delay: '30-minutes' })
    const due = Date.now() + 30 * 60_000
    expect(f.service.state.reminderDueAt).toBe(due)
    await f.service.acknowledge({ action: 'reminded', version: '1.1.0' })
    expect(f.service.state.reminderDueAt).toBe(due)
    const restarted = await fixture({ automatic: false }, f.saved())
    expect(await restarted.service.takeReminder()).toBeNull()
    await vi.advanceTimersByTimeAsync(30 * 60_000)
    restarted.environment.idle = false
    expect(await restarted.service.takeReminder()).toBeNull()
    restarted.environment.idle = true
    expect((await restarted.service.takeReminder())?.latestVersion).toBe('1.1.0')
    await restarted.service.acknowledge({ action: 'reminded', version: '1.1.0' })
    expect(restarted.saved().snoozedReminder).toMatchObject({ reminded: true })
    expect(restarted.service.state.reminderDueAt).toBeNull()
    await restarted.service.acknowledge({ action: 'snooze', version: '1.1.0', delay: 'tomorrow' })
    const tomorrow = new Date()
    tomorrow.setDate(tomorrow.getDate() + 1)
    expect(restarted.service.state).toMatchObject({ ignoredVersion: null, reminderDueAt: tomorrow.getTime(), notification: { payload: { version: '1.1.0' } } })
    await restarted.service.acknowledge({ action: 'ignore', version: '1.1.0' })
    expect(restarted.saved().snoozedReminder).toBeNull()
    expect(restarted.service.state.reminderDueAt).toBeNull()
  })

  it('honors and cancels explicit reminders with automatic checking disabled without starting any background check', async () => {
    const f = await fixture({ enabled: false })
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL * 2)
    expect(f.saved().lastCheckedAt).toBeNull()
    await f.service.check()
    const checkedAt = f.service.state.lastCheckedAt
    await f.service.acknowledge({ action: 'snooze', version: '1.1.0', delay: '30-minutes' })
    await vi.advanceTimersByTimeAsync(30 * 60_000)
    expect((await f.service.takeReminder())?.latestVersion).toBe('1.1.0')
    await f.service.acknowledge({ action: 'reminded', version: '1.1.0' })
    expect(f.service.state).toMatchObject({ enabled: false, lastCheckedAt: checkedAt, reminderDueAt: null, notification: { attention: 'unseen' } })
    await f.service.acknowledge({ action: 'snooze', version: '1.1.0', delay: 'tomorrow' })
    await f.service.acknowledge({ action: 'cancel-snooze', version: '1.1.0' })
    expect(f.service.state).toMatchObject({ reminderDueAt: null, reminderDeferredUntil: null, notification: null })
    f.service.setEnabled(true)
    expect(f.service.state.reminderDueAt).toBeNull()
  })
  it('checks after each startup delay, discovers newer releases despite a recent cached check, and keeps daily checks within a launch', async () => {
    const f = await fixture()
    await vi.advanceTimersByTimeAsync(UPDATE_STARTUP_DELAY - 1)
    expect(f.service.state.result).toBeNull()
    await vi.advanceTimersByTimeAsync(1)
    expect(f.service.state.notification?.attention).toBe('unseen')
    const checkedAt = f.saved().lastCheckedAt
    await f.service.dispose()
    const restored = await fixture({}, f.saved())
    restored.environment.latest = '1.2.0'
    await vi.advanceTimersByTimeAsync(UPDATE_STARTUP_DELAY - 1)
    expect(restored.saved().lastCheckedAt).toBe(checkedAt)
    expect(restored.service.state.result?.latestVersion).toBe('1.1.0')
    await vi.advanceTimersByTimeAsync(1)
    expect(restored.service.state.notification).toMatchObject({ attention: 'unseen', payload: { version: '1.2.0' } })
    const restartedCheckedAt = restored.saved().lastCheckedAt
    restored.environment.latest = '1.3.0'
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL - 1)
    expect(restored.saved().lastCheckedAt).toBe(restartedCheckedAt)
    expect(restored.service.state.result?.latestVersion).toBe('1.2.0')
    await vi.advanceTimersByTimeAsync(1)
    expect(restored.saved().lastCheckedAt).toBe(Date.now())
    expect(restored.service.state.result?.latestVersion).toBe('1.3.0')
    await Promise.all([restored.service.check(), restored.service.check()])
    expect(restored.service.state.notification?.attention).toBe('seen')
    expect(restored.service.state.reminderDueAt).toBeNull()
  })

  it('uses a manual startup check for the daily interval and does not repeat checks when readiness changes', async () => {
    const f = await fixture()
    await f.service.check()
    const checkedAt = f.saved().lastCheckedAt
    f.environment.latest = '1.2.0'
    f.service.setReady(false)
    await vi.advanceTimersByTimeAsync(UPDATE_STARTUP_DELAY)
    f.service.setReady(true)
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL - UPDATE_STARTUP_DELAY - 1)
    expect(f.saved().lastCheckedAt).toBe(checkedAt)
    expect(f.service.state.result?.latestVersion).toBe('1.1.0')
    await vi.advanceTimersByTimeAsync(1)
    expect(f.service.state.result?.latestVersion).toBe('1.2.0')
    expect(f.service.state.notification?.attention).toBe('unseen')
  })

  it('defers to foreground idle time and only consumes a version after display is acknowledged', async () => {
    const f = await fixture()
    await discover(f)
    f.environment.focused = false
    expect(await f.service.takeReminder()).toBeNull()
    f.environment.focused = true
    f.environment.idle = false
    expect(await f.service.takeReminder()).toBeNull()
    expect(f.saved().notifiedVersion).toBeNull()
    f.environment.idle = true
    expect((await f.service.takeReminder())?.latestVersion).toBe('1.1.0')
    expect(f.saved()).toMatchObject({ notifiedVersion: null, lastNotifiedAt: null })
    expect((await f.service.takeReminder())?.latestVersion).toBe('1.1.0')
    f.environment.focused = false
    await f.service.acknowledge({ action: 'reminded', version: '1.1.0' })
    f.environment.focused = true
    const notifiedAt = f.saved().lastNotifiedAt
    await vi.advanceTimersByTimeAsync(1000)
    await f.service.acknowledge({ action: 'reminded', version: '1.1.0' })
    expect(f.saved().lastNotifiedAt).toBe(notifiedAt)
    expect(f.service.state.notification?.attention).toBe('unseen')
    expect(await f.service.takeReminder()).toBeNull()
    const restored = await fixture({}, f.saved())
    expect(await restored.service.takeReminder()).toBeNull()
    expect(restored.service.state.notification?.payload.version).toBe('1.1.0')
  })

  it('revalidates focus and opt-out after an asynchronous idle query', async () => {
    const idle = deferred<boolean>()
    const f = await fixture({ isIdle: () => idle.promise })
    await discover(f)
    const claiming = f.service.takeReminder()
    await vi.advanceTimersByTimeAsync(0)
    f.environment.focused = false
    f.service.setEnabled(false)
    idle.resolve(true)
    expect(await claiming).toBeNull()
    expect(f.saved().notifiedVersion).toBeNull()
    expect(f.service.state.notification).toBeNull()
  })

  it('keeps only the latest notification and respects the cross-version reminder cooldown', async () => {
    const f = await fixture()
    await discover(f)
    await f.service.takeReminder()
    await f.service.acknowledge({ action: 'reminded', version: '1.1.0' })
    const notifiedAt = Date.now()
    f.environment.latest = '1.2.0'
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL)
    expect(f.service.state.notification?.payload.version).toBe('1.2.0')
    await f.service.acknowledge({ action: 'reminded', version: '1.1.0' })
    expect(f.saved().notifiedVersion).toBe('1.1.0')
    expect(f.saved().lastNotifiedAt).toBe(notifiedAt)
    expect(f.service.state.reminderDueAt).toBe(notifiedAt + UPDATE_REMINDER_INTERVAL)
    expect(await f.service.takeReminder()).toBeNull()
    await vi.advanceTimersByTimeAsync(UPDATE_REMINDER_INTERVAL - UPDATE_CHECK_INTERVAL)
    expect((await f.service.takeReminder())?.latestVersion).toBe('1.2.0')
  })

  it('persists skip and read decisions, ignores stale actions, and permits explicit checks of skipped versions', async () => {
    const f = await fixture()
    await discover(f)
    await f.service.acknowledge({ action: 'ignore', version: '1.1.0' })
    const restored = await fixture({}, f.saved())
    expect(restored.service.state.notification).toBeNull()
    expect((await restored.service.check()).latestVersion).toBe('1.1.0')
    expect(restored.service.state.notification).toBeNull()
    restored.environment.latest = '1.2.0'
    await restored.service.check(false)
    await restored.service.acknowledge({ action: 'ignore', version: '1.1.0' })
    expect(restored.service.state.notification?.attention).toBe('unseen')
    await restored.service.acknowledge({ action: 'seen', version: '1.2.0' })
    expect(restored.service.state.notification?.attention).toBe('seen')
    expect(restored.service.state.reminderDueAt).toBeNull()
    const read = await fixture({}, restored.saved())
    expect(read.service.state.notification?.attention).toBe('seen')
  })

  it('cancels background work on opt-out and fences a late response even after re-enabling', async () => {
    const response = deferred<DesktopUpdateCheckResult>()
    const f = await fixture({ check: () => response.promise })
    const checking = f.service.check(false)
    const rejected = expect(checking).rejects.toThrow()
    await vi.advanceTimersByTimeAsync(0)
    f.service.setEnabled(false)
    f.service.setEnabled(true)
    response.resolve(release())
    await rejected
    expect(f.service.state.result).toBeNull()
    expect(f.service.state.notification).toBeNull()
    expect(f.saved().result).toBeNull()
  })

  it('restores a skipped version with reminders and persists the decision across restarts', async () => {
    const f = await fixture()
    await discover(f)
    await f.service.acknowledge({ action: 'reminded', version: '1.1.0' })
    await f.service.acknowledge({ action: 'ignore', version: '1.1.0' })
    expect(f.service.state).toMatchObject({ ignoredVersion: '1.1.0', notification: null, lastCheckedAt: f.saved().lastCheckedAt })
    await f.service.acknowledge({ action: 'unignore', version: '1.2.0' })
    expect(f.service.state.ignoredVersion).toBe('1.1.0')
    await f.service.acknowledge({ action: 'unignore', version: '1.1.0' })
    expect(f.saved()).toMatchObject({ ignoredVersion: null, seenVersion: null, notifiedVersion: null, lastNotifiedAt: null })
    expect(f.service.state).toMatchObject({ notification: { attention: 'unseen' }, reminderDueAt: 0 })
    const restored = await fixture({}, f.saved())
    expect(restored.service.state).toMatchObject({ ignoredVersion: null, notification: { payload: { version: '1.1.0' } } })
  })

  it('restores old skips without resetting attention on newer versions and hides skips already installed', async () => {
    const f = await fixture()
    await discover(f)
    await f.service.acknowledge({ action: 'ignore', version: '1.1.0' })
    f.environment.latest = '1.2.0'
    await f.service.check(false)
    await f.service.acknowledge({ action: 'reminded', version: '1.2.0' })
    await f.service.acknowledge({ action: 'seen', version: '1.2.0' })
    await f.service.acknowledge({ action: 'unignore', version: '1.1.0' })
    expect(f.saved()).toMatchObject({ ignoredVersion: null, seenVersion: '1.2.0', notifiedVersion: '1.2.0' })
    expect(f.service.state).toMatchObject({ notification: { attention: 'seen' }, reminderDueAt: null })
    await f.service.acknowledge({ action: 'ignore', version: '1.2.0' })
    const upgraded = await fixture({ currentVersion: '1.2.0' }, f.saved())
    expect(upgraded.service.state).toMatchObject({ ignoredVersion: null, notification: null })
  })

  it('does not auto-check development builds and clears obsolete availability after upgrading', async () => {
    const f = await fixture({ automatic: false })
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL * 2)
    expect(f.service.state.result).toBeNull()
    await f.service.check(false)
    const upgraded = await fixture({ currentVersion: '1.1.0', automatic: false }, f.saved())
    expect(upgraded.service.state.result).toMatchObject({ currentVersion: '1.1.0', status: 'up_to_date' })
    expect(upgraded.service.state.notification).toBeNull()
  })

  it('retains the last successful check through background and manual failures, then recovers on retry', async () => {
    const initial = { ...emptyUpdateRecord(), lastCheckedAt: Date.now(), lastSuccessfulCheckAt: Date.now(), result: release(), discoveredAt: Date.now() }
    const f = await fixture({
      check: async () => {
        throw new Error('offline')
      },
    }, initial)
    await vi.advanceTimersByTimeAsync(UPDATE_STARTUP_DELAY)
    expect(f.service.state).toMatchObject({ checking: false, checkFailed: true, lastSuccessfulCheckAt: initial.lastSuccessfulCheckAt, result: initial.result, notification: { attention: 'unseen' } })
    expect(f.errors).toEqual(['background'])
    expect(f.saved().lastCheckedAt).toBe(Date.now())
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL - 1)
    expect(f.errors).toEqual(['background'])
    await vi.advanceTimersByTimeAsync(1)
    expect(f.errors).toEqual(['background', 'background'])
    await expect(f.service.check()).rejects.toThrow('offline')
    expect(f.service.state).toMatchObject({ checkFailed: true, lastSuccessfulCheckAt: initial.lastSuccessfulCheckAt, result: initial.result })
    f.input.check = async () => release('1.2.0')
    await f.service.check()
    expect(f.service.state).toMatchObject({ checkFailed: false, lastSuccessfulCheckAt: Date.now(), result: release('1.2.0') })
  })

  it('does not mark a reminder delivered when persistence fails', async () => {
    const initial = { ...emptyUpdateRecord(), result: release(), discoveredAt: Date.now() }
    const f = await fixture({
      automatic: false,
      store: {
        read: async () => initial,
        write: async () => {
          throw new Error('disk unavailable')
        },
      },
    })
    expect((await f.service.takeReminder())?.latestVersion).toBe('1.1.0')
    await expect(f.service.acknowledge({ action: 'reminded', version: '1.1.0' })).rejects.toThrow('disk unavailable')
    expect(f.service.state.reminderDueAt).not.toBeNull()
    expect(f.service.state.notification?.attention).toBe('unseen')
  })
})
