import type { BackupScheduleState } from '@buddy-shared/sync/backupSchedule'
import type { SyncState } from '@buddy-shared/sync/syncApi'
import { deferred } from '@buddy-tests/deferred'
import { expect, it } from 'vitest'
import { effectScope, shallowRef } from 'vue'
import { useCloudBackupFeedback } from '../useCloudBackupFeedback'

function state(schedule: Partial<BackupScheduleState> = {}): SyncState {
  return {
    enabled: true,
    selectedAdapter: 'webdav',
    activeConnectionId: 'fixture',
    connections: [],
    activity: null,
    scheduleError: false,
    schedules: [{
      connectionId: 'fixture',
      policy: { frequency: 'daily', time: '12:00', weekday: 0, scopes: ['tasks'], credentials: false },
      nextRunAt: '2026-10-14T12:00:00.000Z',
      lastSuccessAt: null,
      retryAt: null,
      status: 'waiting',
      error: null,
      cleanupError: false,
      ...schedule,
    }],
  }
}

function fixture() {
  const response = deferred<SyncState>()
  const messages: { type: string, content: string }[] = []
  let receive: (value: SyncState) => void = () => {}
  const scope = effectScope()
  const feedback = scope.run(() => useCloudBackupFeedback({
    api: {
      backupNow: () => response.promise,
      onChanged: (listener) => {
        receive = listener
        return () => {
          receive = () => {}
        }
      },
    },
    language: shallowRef('zh-CN'),
    notify: (type, content) => messages.push({ type, content }),
  }))!
  return { response, messages, scope, feedback, emit: (value: SyncState) => receive(value) }
}

it('reports the manual backup result once and leaves automatic backups and retries quiet', async () => {
  const f = fixture()
  f.emit(state({ status: 'failed' }))
  const request = f.feedback.backupNow({ scopes: ['tasks'], credentials: false })
  f.response.resolve(state())
  await request
  f.emit(state({ status: 'running' }))
  expect(f.messages).toEqual([])
  f.emit(state({ status: 'failed', error: 'SYNC_AUTHENTICATION_FAILED' }))
  f.emit(state({ status: 'failed', error: 'SYNC_AUTHENTICATION_FAILED' }))
  f.emit(state({ status: 'idle', lastSuccessAt: '2026-10-14T12:05:00.000Z' }))
  expect(f.messages).toEqual([expect.objectContaining({ type: 'error' })])
  f.scope.stop()
})

it('handles completion before the request reply without treating an older success as this result', async () => {
  const f = fixture()
  const previous = '2026-10-13T12:00:00.000Z'
  const request = f.feedback.backupNow({ scopes: ['tasks'], credentials: false })
  f.emit(state({ status: 'running', lastSuccessAt: previous }))
  expect(f.messages).toEqual([])
  const completed = state({ status: 'idle', lastSuccessAt: '2026-10-14T12:00:00.000Z' })
  f.emit(completed)
  f.response.resolve(state({ lastSuccessAt: previous }))
  await request
  f.emit(completed)
  expect(f.messages).toEqual([expect.objectContaining({ type: 'success' })])
  f.scope.stop()
})

it('does not report a later automatic result after submission fails or its owner is disposed', async () => {
  const rejected = fixture()
  const request = rejected.feedback.backupNow({ scopes: ['tasks'], credentials: false })
  rejected.response.reject(new Error('BACKUP_PASSWORD_REQUIRED'))
  await expect(request).rejects.toThrow('BACKUP_PASSWORD_REQUIRED')
  rejected.emit(state({ status: 'idle', lastSuccessAt: '2026-10-14T12:00:00.000Z' }))
  expect(rejected.messages).toEqual([])
  rejected.scope.stop()
  const disposed = fixture()
  const pending = disposed.feedback.backupNow({ scopes: ['tasks'], credentials: false })
  disposed.scope.stop()
  disposed.response.resolve(state())
  await pending
  disposed.emit(state({ status: 'failed', error: 'SYNC_FAILED' }))
  expect(disposed.messages).toEqual([])
})
