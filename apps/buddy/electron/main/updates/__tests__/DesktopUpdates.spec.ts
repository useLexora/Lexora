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
  it('delays startup checks, persists the daily limit, and coalesces repeated manual requests', async () => {
    const f = await fixture()
    await vi.advanceTimersByTimeAsync(UPDATE_STARTUP_DELAY - 1)
    expect(f.service.state.result).toBeNull()
    await vi.advanceTimersByTimeAsync(1)
    expect(f.service.state.notification?.attention).toBe('unseen')
    const checkedAt = f.saved().lastCheckedAt
    await f.service.dispose()
    const restored = await fixture({}, f.saved())
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL - 1)
    expect(restored.saved().lastCheckedAt).toBe(checkedAt)
    await vi.advanceTimersByTimeAsync(1)
    expect(restored.saved().lastCheckedAt).toBe(Date.now())
    const first = restored.service.check()
    expect(restored.service.check()).toBe(first)
    await first
    expect(restored.service.state.notification?.attention).toBe('seen')
    expect(restored.service.state.reminderDueAt).toBeNull()
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

  it('keeps manual checking available while disabled without reminders or automatic network work', async () => {
    const f = await fixture({ enabled: false })
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL * 2)
    expect(f.saved().lastCheckedAt).toBeNull()
    expect((await f.service.check()).latestVersion).toBe('1.1.0')
    expect(f.service.state.notification).toBeNull()
    f.service.setEnabled(true)
    expect(f.service.state.reminderDueAt).toBeNull()
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

  it('keeps valid cached results on network failure and never converts failure into up-to-date', async () => {
    const f = await fixture({
      check: async () => {
        throw new Error('offline')
      },
    })
    await vi.advanceTimersByTimeAsync(UPDATE_STARTUP_DELAY)
    expect(f.service.state).toMatchObject({ checking: false, result: null, notification: null })
    expect(f.errors).toEqual(['background'])
    expect(f.saved().lastCheckedAt).toBe(Date.now())
    await expect(f.service.check()).rejects.toThrow('offline')
    expect(f.service.state.result).toBeNull()
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
