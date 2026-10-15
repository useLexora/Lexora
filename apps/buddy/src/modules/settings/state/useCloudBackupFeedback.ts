import type { BackupOptions } from '@buddy-shared/storage/backupScope'
import type { BackupConfiguration, SyncApi, SyncState } from '@buddy-shared/sync/syncApi'
import type { Ref } from 'vue'
import { onScopeDispose } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import { cloudBackupError } from '../model/cloudBackupError'

interface PendingBackup {
  connectionId?: string
  previousSuccess?: string | null
  latest?: SyncState
}

export function useCloudBackupFeedback(options: {
  api: Pick<SyncApi, 'backupNow' | 'onChanged'>
  language: Readonly<Ref<string>>
  notify: (type: 'success' | 'error', content: string) => void
}) {
  const { t } = useBuddyI18n(options.language)
  let pending: PendingBackup | undefined

  function receive(state: SyncState) {
    const attempt = pending
    if (!attempt)
      return
    attempt.latest = state
    if (!attempt.connectionId)
      return
    const schedule = state.schedules.find(item => item.connectionId === attempt.connectionId)
    if (state.scheduleError || schedule?.status === 'failed') {
      pending = undefined
      const english = options.language.value === 'en-US'
      options.notify('error', `${english ? 'Cloud backup did not complete: ' : '云备份未完成：'}${cloudBackupError(state.scheduleError ? 'BACKUP_SCHEDULE_UNAVAILABLE' : schedule?.error, english)}`)
    }
    else if (schedule?.lastSuccessAt && schedule.lastSuccessAt !== attempt.previousSuccess) {
      pending = undefined
      options.notify('success', t('desktop.backup.completed'))
    }
  }

  const unsubscribe = options.api.onChanged(receive)
  onScopeDispose(() => {
    unsubscribe()
    pending = undefined
  })

  async function backupNow(selection: BackupOptions, configuration?: BackupConfiguration) {
    const attempt: PendingBackup = {}
    pending = attempt
    try {
      const state = await options.api.backupNow(selection, configuration)
      if (pending === attempt) {
        attempt.connectionId = state.activeConnectionId ?? undefined
        attempt.previousSuccess = state.schedules.find(item => item.connectionId === attempt.connectionId)?.lastSuccessAt ?? null
        receive(attempt.latest ?? state)
      }
      return state
    }
    catch (error) {
      if (pending === attempt)
        pending = undefined
      throw error
    }
  }

  return { backupNow }
}
