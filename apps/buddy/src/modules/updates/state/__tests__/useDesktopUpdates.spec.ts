import type { DesktopUpdateCheckResult, DesktopUpdateState } from '@buddy-electron/shared/desktopUpdates'
import { deferred } from '@buddy-tests/deferred'
import { expect, it, vi } from 'vitest'
import { useDesktopUpdates } from '../useDesktopUpdates'

const result: DesktopUpdateCheckResult = { currentVersion: '1.0.0', latestVersion: '1.1.0', status: 'update_available', releaseUrl: 'https://github.com/useLexora/Lexora/releases/tag/v1.1.0', releaseNotes: 'Update' }
const empty: DesktopUpdateState = { revision: 0, checking: false, enabled: true, result: null, notification: null, reminderDueAt: null }

it('does not let a late startup snapshot overwrite newer availability or re-enable disabled notifications', async () => {
  const loading = deferred<DesktopUpdateState>()
  let emit = (_state: DesktopUpdateState) => {}
  const store = useDesktopUpdates({
    checkForUpdates: async () => result,
    updates: {
      getState: () => loading.promise,
      onChanged: (listener) => {
        emit = listener
        return () => {}
      },
      acknowledge: async () => empty,
      takeReminder: async () => null,
    },
  })
  const read = store.load()
  emit({ ...empty, revision: 2, enabled: false, result })
  loading.resolve({ ...empty, revision: 1 })
  await read
  expect(store.state.value).toMatchObject({ revision: 2, enabled: false, result })
  store.dispose()
  emit({ ...empty, revision: 3 })
  expect(store.state.value?.revision).toBe(2)
})

it('keeps manual errors retryable and discards replies after closing or disposal', async () => {
  const response = deferred<DesktopUpdateCheckResult>()
  const check = vi.fn<() => Promise<DesktopUpdateCheckResult>>().mockRejectedValueOnce(new Error('offline')).mockReturnValueOnce(response.promise).mockResolvedValue(result)
  const store = useDesktopUpdates({
    checkForUpdates: check,
    updates: { getState: async () => empty, onChanged: () => () => {}, acknowledge: async () => empty, takeReminder: async () => null },
  })
  await expect(store.check()).rejects.toThrow('offline')
  expect(store.details.value).toBeNull()
  const stale = store.check()
  store.closeDetails()
  response.resolve(result)
  await stale
  expect(store.details.value).toBeNull()
  await store.check()
  expect(store.details.value?.latestVersion).toBe('1.1.0')
  store.closeDetails()
  store.dispose()
  await store.check()
  expect(store.details.value).toBeNull()
})
