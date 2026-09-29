import type { DesktopUpdateState } from '@buddy-electron/shared/desktopUpdates'
import type { LocalNotification, LocalNotificationList } from '@buddy-shared/notifications/notificationApi'
import { deferred } from '@buddy-tests/deferred'
import { describe, expect, it, vi } from 'vitest'
import { shallowRef } from 'vue'
import { useNotificationCenterStore } from '../useNotificationCenterStore'

function list(seen = false): LocalNotificationList {
  const item: LocalNotification = { id: 'catalog', revision: '1', attention: seen ? 'seen' : 'unseen', audience: 'device', lifecycle: 'active', occurredAt: '2026-09-08T00:00:00.000Z', origin: 'local-runtime', resolvedAt: null, action: { type: 'open-model-settings' }, kind: 'model.source-parameters-updated', payload: { modelCount: 1 } }
  return { items: [item], unseenCount: seen ? 0 : 1 }
}
function fixture() {
  let listeners = 0
  let changed: (event: { revision: number }) => void = () => {}
  const subscribe = () => {
    listeners += 1
    return () => {
      listeners -= 1
    }
  }
  const api = {
    notifications: { onChanged: (listener: (event: { revision: number }) => void) => {
      changed = listener
      const stop = subscribe()
      return () => {
        stop()
        changed = () => {}
      }
    }, list: vi.fn(async () => list()), markSeen: vi.fn(async () => list(true)), markAllSeen: vi.fn(async () => list(true)) },
    chat: { onRunEvent: subscribe },
    automations: { onChanged: subscribe },
  }
  const updates = { state: shallowRef<DesktopUpdateState | null>(null), markSeen: vi.fn(async (_version: string) => {}) }
  const store = useNotificationCenterStore(api, updates)
  return { api, store, updates, changed: () => changed({ revision: 1 }), listeners: () => listeners }
}

describe('notification state ownership', () => {
  it('preserves unread and active priority even without an update notification', async () => {
    const f = fixture()
    const item = list().items[0]!
    const items: LocalNotification[] = [
      { ...item, id: 'unread-active' },
      { ...item, id: 'unread-resolved', lifecycle: 'resolved', occurredAt: '2026-09-10T00:00:00.000Z', resolvedAt: '2026-09-10T00:00:00.000Z' },
      { ...item, id: 'seen-active', attention: 'seen' },
      { ...item, id: 'seen-resolved', attention: 'seen', lifecycle: 'resolved', occurredAt: '2026-09-11T00:00:00.000Z', resolvedAt: '2026-09-11T00:00:00.000Z' },
    ]
    f.api.notifications.list.mockResolvedValue({ items, unseenCount: 2 })
    await f.store.load()
    expect(f.store.items.value).toEqual(items)
    expect(f.store.unseenCount.value).toBe(2)
    f.store.dispose()
  })

  it('composes independently owned update notifications, marks both sources seen, and removes opt-out attention', async () => {
    const f = fixture()
    await f.store.load()
    f.updates.state.value = {
      revision: 1,
      enabled: true,
      checking: false,
      result: null,
      reminderDueAt: 0,
      notification: {
        id: 'desktop.update',
        revision: '1.1.0',
        kind: 'app.update-available',
        origin: 'desktop',
        attention: 'unseen',
        occurredAt: '2026-09-09T00:00:00.000Z',
        action: { type: 'open-app-update' },
        payload: { version: '1.1.0' },
      },
    }
    f.updates.markSeen.mockImplementation(async (version) => {
      const state = f.updates.state.value!
      if (state.notification?.revision === version)
        f.updates.state.value = { ...state, notification: { ...state.notification, attention: 'seen' } }
    })
    expect(f.store.items.value.map(item => item.id)).toEqual(['desktop.update', 'catalog'])
    expect(f.store.unseenCount.value).toBe(2)
    const unseen = f.updates.state.value
    f.updates.state.value = { ...unseen, notification: { ...unseen.notification!, attention: 'seen' } }
    expect(f.store.items.value.map(item => item.id)).toEqual(['catalog', 'desktop.update'])
    expect(await f.store.markAllSeen()).toBe(true)
    expect(f.store.unseenCount.value).toBe(0)
    const state = f.updates.state.value!
    f.updates.state.value = { ...state, notification: { ...state.notification!, revision: '1.2.0', attention: 'unseen', payload: { version: '1.2.0' } } }
    expect(f.store.items.value).toHaveLength(2)
    expect(f.store.unseenCount.value).toBe(1)
    f.updates.state.value = { ...f.updates.state.value, enabled: false, notification: null }
    expect(f.store.items.value).toEqual(list(true).items)
    expect(f.store.unseenCount.value).toBe(0)
    f.store.dispose()
  })

  it('refreshes from notification facts and rejects a list taken before a newer fact', async () => {
    const f = fixture()
    const stale = deferred<LocalNotificationList>()
    f.api.notifications.list.mockReturnValueOnce(stale.promise).mockResolvedValue(list(true))
    const reading = f.store.load()
    f.changed()
    stale.resolve(list())
    await reading
    await vi.waitFor(() => expect(f.store.items.value[0]?.attention).toBe('seen'))
    expect(f.store.unseenCount.value).toBe(0)
    f.store.dispose()
    f.changed()
    expect(f.listeners()).toBe(0)
  })

  it('refreshes authoritative state when a failed mutation overtakes an in-flight list', async () => {
    const f = fixture()
    const reading = deferred<LocalNotificationList>()
    const writing = deferred<LocalNotificationList>()
    f.api.notifications.list.mockReturnValueOnce(reading.promise).mockResolvedValue(list())
    f.api.notifications.markAllSeen.mockReturnValueOnce(writing.promise)
    const loading = f.store.load()
    const marking = f.store.markAllSeen()
    reading.resolve(list(true))
    await loading
    writing.reject(new Error('commit result unavailable'))
    expect(await marking).toBe(false)
    await vi.waitFor(() => expect(f.store.items.value).toEqual(list().items))
    expect(f.store.unseenCount.value).toBe(1)
    f.store.dispose()
  })

  it('keeps a seen mutation when a pre-mutation list response arrives late', async () => {
    const f = fixture()
    const loading = deferred<LocalNotificationList>()
    f.api.notifications.list.mockReturnValueOnce(loading.promise).mockResolvedValue(list(true))
    const load = f.store.load()
    await f.store.markSeen(list().items[0]!)
    loading.resolve(list())
    await load
    expect(f.store.unseenCount.value).toBe(0)
    expect(f.store.items.value[0]?.attention).toBe('seen')
    f.store.dispose()
  })

  it('serializes attention mutations so both persisted results remain represented', async () => {
    const f = fixture()
    const first = deferred<LocalNotificationList>()
    const seen = list(true).items[0]!
    const unseen = { ...list().items[0]!, id: 'second' }
    f.api.notifications.markSeen.mockReturnValueOnce(first.promise)
    f.api.notifications.markAllSeen.mockResolvedValueOnce({ items: [seen, { ...unseen, attention: 'seen' }], unseenCount: 0 })
    const a = f.store.markSeen(list().items[0]!)
    const b = f.store.markAllSeen()
    first.resolve({ items: [seen, unseen], unseenCount: 1 })
    expect(await Promise.all([a, b])).toEqual([true, true])
    expect(f.store.unseenCount.value).toBe(0)
    expect(f.store.items.value.every(item => item.attention === 'seen')).toBe(true)
    f.store.dispose()
  })

  it.each(['resolve', 'reject'])('ignores a late list %s and unsubscribes once after disposal', async (result) => {
    const f = fixture()
    const pending = deferred<LocalNotificationList>()
    f.api.notifications.list.mockReturnValueOnce(pending.promise)
    const loading = f.store.load()
    void f.store.load()
    f.store.dispose()
    f.store.dispose()
    if (result === 'resolve')
      pending.resolve(list())
    else
      pending.reject(new Error('late response'))
    await loading
    expect(f.store.items.value).toEqual([])
    expect(f.store.error.value).toBeNull()
    expect(f.listeners()).toBe(0)
    expect(await f.store.load()).toBe(false)
  })

  it('does not apply a mutation response after disposal', async () => {
    const f = fixture()
    await f.store.load()
    const pending = deferred<LocalNotificationList>()
    f.api.notifications.markSeen.mockReturnValueOnce(pending.promise)
    const marking = f.store.markSeen(list().items[0]!)
    await Promise.resolve()
    f.store.dispose()
    pending.resolve(list(true))
    expect(await marking).toBe(false)
    expect(f.store.unseenCount.value).toBe(1)
  })
})
